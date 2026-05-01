/**
 * Agent Tools — shared OpenAI function-calling schemas + dispatcher.
 *
 * Both the autonomous customer-reply path (incoming-worker/ai-bot) and the
 * agent-assist path (ai service/openai.provider) pass these schemas into
 * `chat.completions.create({ tools })` and route tool_calls through
 * `dispatchToolCall()` here so dispatch logic is not duplicated.
 *
 * Dispatch uses plain fetch() against the conversation service so this file
 * has no intra-service import cycles. Auth is propagated via Bearer token
 * (either forwarded from the caller or INTERNAL_SERVICE_TOKEN).
 */

export interface AgentToolContext {
  tenantId: string;
  conversationId?: string;
  /** Required for link_customer_identifier dispatch. */
  contactId?: string;
  /** Propagated as Bearer token to downstream conversation service. */
  authToken?: string;
  /** Surfaced into /identity/link for idempotent dedupe. */
  messageId?: string;
  /**
   * Execution mode. Defaults to "agent" (autonomous bot replying to a
   * customer). When set to "copilot" (human agent is in the loop), the
   * dispatcher diverts gate REQUIRE_APPROVAL decisions to a
   * `proposeQuickAction` side effect instead of creating an
   * ApprovalRequest — the human agent in the inbox decides whether to
   * fire the action from the suggestions panel.
   */
  mode?: "agent" | "copilot";
}

export interface AgentToolSideEffect {
  /** escalate_to_human was requested — caller must hand off to human. */
  escalate?: {
    reason: string;
    priority?: "low" | "medium" | "high";
    summary?: string;
  };
  /**
   * The tool call was gated by evaluateToolGate and requires human
   * approval. The caller MUST stop generating further replies and
   * pause the conversation until the approval is decided.
   * approvalRequestId references the created ApprovalRequest row.
   */
  awaitingApproval?: {
    approvalRequestId: string;
    tool: string;
    reason: string;
  };
  /**
   * The tool call was explicitly denied by tenant permission. The bot
   * should NOT retry and should optionally inform the customer.
   */
  denied?: {
    tool: string;
    reason: string;
  };
  /**
   * Copilot-mode replacement for `awaitingApproval`. The tool was gated
   * as REQUIRE_APPROVAL but the human agent is already in the loop, so
   * we surface it as a "proposed quick action" the agent can fire from
   * the suggestions panel instead of opening a separate approval page.
   * Only emitted when AgentToolContext.mode === "copilot".
   */
  proposeQuickAction?: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  };
}

export interface AgentToolDispatchResult {
  toolCallId: string;
  /** JSON-stringified result injected back into the chat loop. */
  content: string;
  sideEffect?: AgentToolSideEffect;
}

// ─── Tool schemas (OpenAI function-calling format) ────────────

export const LINK_IDENTIFIER_TOOL = {
  type: "function" as const,
  function: {
    name: "link_customer_identifier",
    description:
      "Link an email or phone number that the customer has explicitly stated as their own to their contact record. " +
      "This enables cross-channel history unification (e.g. the same person messaging on Instagram and WhatsApp). " +
      "Call ONLY when the customer clearly states ownership ('my email is...', 'my number is...', 'send it to me at...'). " +
      "DO NOT call for third-party emails/phones (e.g. 'contact support@x.com' — that's not the customer's own address). " +
      "The server decides whether to attach the identifier or create a pending merge suggestion.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["email", "phone"],
          description: "Which identifier type the customer shared.",
        },
        value: {
          type: "string",
          description:
            "The literal identifier the customer wrote. Copy it verbatim — do not normalize, format, or guess.",
        },
        confidence: {
          type: "number",
          description:
            "Your confidence that the customer owns this identifier. 0.9+ for clear statements of ownership, 0.6–0.8 for implied ownership, below 0.5 — do not call this tool.",
        },
      },
      required: ["type", "value", "confidence"],
    },
  },
};

export const ESCALATE_TOOL = {
  type: "function" as const,
  function: {
    name: "escalate_to_human",
    description:
      "Transfer the conversation to a human agent. Call when the customer explicitly asks for a human, when you cannot resolve their issue, when the customer is very upset, or when escalation rules are triggered.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for escalation.",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Urgency level.",
        },
        summary: {
          type: "string",
          description: "Brief summary of the conversation so far for the human agent.",
        },
      },
      required: ["reason"],
    },
  },
};

export interface BuildAgentToolsOptions {
  identityLinking?: boolean;
  escalation?: boolean;
  /** Extra tenant-defined function schemas to append. */
  extra?: Array<Record<string, unknown>>;
  /**
   * Filter integration tools by execution mode (CatalogTool.allowedModes).
   * "AUTO" — autonomous bot. "ASSIST" — copilot (human in the loop).
   * Tools whose allowedModes array does not include this mode are dropped.
   * Omit to include every tool the agent has permission for.
   */
  allowedMode?: "AUTO" | "ASSIST";
}

export function buildAgentTools(opts: BuildAgentToolsOptions = {}): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (opts.identityLinking !== false) tools.push(LINK_IDENTIFIER_TOOL as any);
  if (opts.escalation !== false) tools.push(ESCALATE_TOOL as any);
  if (opts.extra?.length) tools.push(...opts.extra);
  return tools;
}

/**
 * Load the tool surface for an autonomous AI agent, merging:
 *   - The static `link_customer_identifier` + `escalate_to_human` helpers
 *   - Integration tools the operator explicitly allowed for THIS ai agent
 *     via AgentToolPermission. Filtered to enabled TenantTool rows on a
 *     CONNECTED integration.
 *
 * The result is shaped as OpenAI function-call tool specs, ready to pass
 * to chat.completions.create({ tools }). Each integration tool is named
 * `integration.<catalogToolSlug>` so the dispatcher can recognise it.
 *
 * Returns the exact same shape as `buildAgentTools` so callers can swap
 * in-place.
 */
export async function buildAgentToolsForAIAgent(
  tenantId: string,
  aiAgentId: string | null | undefined,
  opts: BuildAgentToolsOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const base = buildAgentTools(opts);
  if (!aiAgentId) return base;

  let integrationTools: Array<Record<string, unknown>> = [];
  try {
    const { prisma } = await import("./prisma");
    const rows = await prisma.agentToolPermission.findMany({
      where: {
        tenantId,
        aiAgentId,
        isAllowed: true,
        tenantTool: {
          isEnabled: true,
          tenantIntegration: { status: "CONNECTED" },
        },
      },
      include: {
        tenantTool: {
          include: { catalogTool: true },
        },
      },
    });
    const allowedMode = opts.allowedMode;
    const filtered = allowedMode
      ? rows.filter((row: any) => {
          const am = row.tenantTool?.catalogTool?.allowedModes;
          // CatalogTool.allowedModes default is ["AUTO","ASSIST"]; treat
          // missing/malformed as "permits all" so a botched seed doesn't
          // silently drop tools.
          if (!Array.isArray(am)) return true;
          return am.includes(allowedMode);
        })
      : rows;
    integrationTools = filtered.map((row: any) => {
      const ct = row.tenantTool.catalogTool;
      // Prefer the catalog's own inputSchema if it's a JSON-schema object;
      // otherwise emit an empty-object schema so OpenAI will still accept
      // the tool and let the model emit a free-form payload.
      const parameters =
        ct.inputSchema && typeof ct.inputSchema === "object" && !Array.isArray(ct.inputSchema)
          ? ct.inputSchema
          : { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name: `integration_${ct.slug}`,
          description: composeToolDescription(ct),
          parameters,
        },
      };
    });
  } catch (err: any) {
    // Integration tool loading must never break the bot. Fall back to base
    // tools so link_customer_identifier + escalate_to_human still work.
    console.warn("[agent-tools] failed to load integration tools:", err?.message);
  }

  return [...base, ...integrationTools];
}

/**
 * Build the OpenAI tool `description` field for an integration tool.
 *
 * Concatenates (in priority order for the LLM's selection signal):
 *   - the bare `description` (what the tool does),
 *   - `whenToUse` if present (the operator-authored selection rule),
 *   - one worked example from `exampleUsage` if present.
 *
 * This is what gates "should I call this tool right now?" — putting the
 * gating language here, in the tool spec the LLM sees, decouples it from
 * the agent's hand-written system prompt and stops over-firing when the
 * prompt forgets to mention a tool.
 */
function composeToolDescription(ct: {
  name: string;
  description: string | null;
  whenToUse?: string | null;
  exampleUsage?: unknown;
}): string {
  const parts: string[] = [];
  parts.push(ct.description || ct.name);
  if (ct.whenToUse && ct.whenToUse.trim()) {
    parts.push(`When to use: ${ct.whenToUse.trim()}`);
  }
  const example = pickFirstExample(ct.exampleUsage);
  if (example) parts.push(`Example: ${example}`);
  return parts.join("\n\n");
}

function pickFirstExample(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  if (!first || typeof first !== "object") return null;
  const e = first as Record<string, unknown>;
  const segments: string[] = [];
  if (e.input !== undefined) {
    segments.push(`input=${typeof e.input === "string" ? e.input : JSON.stringify(e.input)}`);
  }
  if (e.output !== undefined) {
    segments.push(`output=${typeof e.output === "string" ? e.output : JSON.stringify(e.output)}`);
  }
  if (e.note && typeof e.note === "string") segments.push(`(${e.note})`);
  return segments.length ? segments.join(" → ") : null;
}

// ─── Dispatcher ──────────────────────────────────────────────

async function callConversationService(
  method: "POST",
  path: string,
  body: unknown,
  ctx: AgentToolContext,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const base = process.env.CONVERSATION_SERVICE_URL ?? "http://conversation-service:3000";
  const url = `${base.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = ctx.authToken ?? process.env.INTERNAL_SERVICE_TOKEN;
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = ctx.tenantId;
  try {
    const res = await fetch(url, { method, headers, body: JSON.stringify(body ?? {}) });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const errBody =
        typeof data === "object" && data && "error" in (data as any)
          ? String((data as any).error)
          : `upstream ${res.status}`;
      return { ok: false, status: res.status, data, error: errBody };
    }
    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? "fetch failed" };
  }
}

export interface ToolCallLike {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export async function dispatchToolCall(
  toolCall: ToolCallLike,
  ctx: AgentToolContext,
): Promise<AgentToolDispatchResult> {
  const name = toolCall.function?.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function?.arguments || "{}");
  } catch {
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({ ok: false, error: "invalid JSON arguments" }),
    };
  }

  // ── F4 gate: tenant-scoped tool permission + HITL approval ──
  // Every bot-initiated tool call flows through evaluateToolGate before
  // dispatch. DENY short-circuits with an error the LLM can see and
  // pivot from. REQUIRE_APPROVAL creates an ApprovalRequest row and
  // returns a side-effect that tells the caller to pause the
  // conversation until a human decides.
  //
  // The two tools hardcoded here today (link_customer_identifier,
  // escalate_to_human) are low-risk by default so this is a no-op for
  // them — but it means ANY new tool added to this dispatcher is
  // automatically gated through the same code path. That's the whole
  // point: replace scattered ad-hoc checks with one entry point.
  try {
    const { evaluateToolGate, createApprovalRequest } = await import("./tool-gate").then(
      async (g) => ({
        evaluateToolGate: g.evaluateToolGate,
        createApprovalRequest: (await import("./approval-requests")).createApprovalRequest,
      }),
    );
    const gate = await evaluateToolGate(ctx.tenantId, name);
    if (gate.decision === "DENY") {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: gate.reason, denied: true }),
        sideEffect: { denied: { tool: name, reason: gate.reason } },
      };
    }
    if (gate.decision === "REQUIRE_APPROVAL") {
      // Copilot mode short-circuit: the human agent is already in the
      // loop, so don't burn an approval page. Hand the proposed call back
      // to the route as a quick action — the agent fires it from the
      // suggestions panel if they want it.
      if (ctx.mode === "copilot") {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({
            ok: false,
            proposed_quick_action: true,
            message:
              "Action proposed. The human agent will decide whether to run it from the suggestions panel.",
          }),
          sideEffect: {
            proposeQuickAction: { tool: name, args, reason: gate.reason },
          },
        };
      }
      // Only create an approval row if we have enough context to route
      // a human back to it. Without conversationId there's no inbox
      // surface, so we fail closed with a plain error.
      if (!ctx.conversationId) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({
            ok: false,
            error: "tool requires approval but no conversation context available",
          }),
        };
      }
      // Dedupe — if an approval for this same tool is already pending on
      // this conversation, reuse it. The bot keeps replying to the
      // customer (handledBy="awaiting_approval" no longer blocks the
      // worker), and we don't mint duplicate ApprovalRequest rows every
      // turn the model decides to re-propose the action. The model also
      // gets a "## Pending Approval" notice in its system prompt
      // (ai-bot.service.ts) so it shouldn't be calling here in the first
      // place — this is the belt-and-suspenders.
      try {
        const { prisma: dedupePrisma } = await import("./prisma");
        const existing = await (dedupePrisma as any).approvalRequest.findFirst({
          where: {
            tenantId: ctx.tenantId,
            conversationId: ctx.conversationId,
            tool: name,
            status: "PENDING",
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (existing) {
          return {
            toolCallId: toolCall.id,
            content: JSON.stringify({
              ok: false,
              awaiting_approval: true,
              approval_request_id: existing.id,
              deduped: true,
              status: "pending_human_approval",
              instruction:
                "Approval already pending for this action. Continue the conversation naturally in the customer's language; do not mention approvals, the team, or any internal process.",
            }),
            sideEffect: {
              awaitingApproval: {
                approvalRequestId: existing.id,
                tool: name,
                reason: "duplicate of pending approval",
              },
            },
          };
        }
      } catch (err: any) {
        // Lookup failure must not break the gate — fall through and
        // create a fresh approval. Worst case: a duplicate row.
        console.warn("[agent-tools] pending-approval dedupe lookup failed:", err?.message);
      }
      const approval = await createApprovalRequest({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        messageId: ctx.messageId,
        tool: name,
        params: args,
        summary: summarizeToolCall(name, args),
        reason: gate.reason,
        // riskLevel here is a display field on the ApprovalRequest row, not a
        // gating signal — the gate decision lives in tool-gate.ts. Tag as
        // "approval_required" so the inbox UI groups it correctly.
        riskLevel: "high",
        riskTags: ["REQUIRES_APPROVAL"],
        requestedBy: "bot",
        gate,
      });
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          awaiting_approval: true,
          approval_request_id: approval.id,
          status: "pending_human_approval",
          instruction:
            "Action paused for approval. Continue the conversation naturally in the customer's language; do not mention approvals, queues, the team, or any internal process.",
        }),
        sideEffect: {
          awaitingApproval: {
            approvalRequestId: approval.id,
            tool: name,
            reason: gate.reason,
          },
        },
      };
    }
  } catch (err: any) {
    // Gate failures must NOT silently allow — fail closed.
    console.error("[agent-tools] gate evaluation failed:", err?.message);
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({
        ok: false,
        error: "permission gate unavailable; refusing to run tool",
      }),
    };
  }

  if (name === "link_customer_identifier") {
    if (!ctx.contactId) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "no contactId in conversation context" }),
      };
    }
    const body = {
      contactId: ctx.contactId,
      type: args.type,
      value: args.value,
      confidence: args.confidence,
      messageId: ctx.messageId ?? null,
      reason: "extracted by AI agent from conversation",
    };
    const r = await callConversationService("POST", "/api/identity/link", body, ctx);
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify(
        r.ok ? { ok: true, result: r.data } : { ok: false, error: r.error },
      ),
    };
  }

  if (name === "escalate_to_human") {
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({ ok: true, escalated: true }),
      sideEffect: {
        escalate: {
          reason: String(args.reason || "AI requested escalation"),
          priority: (args.priority as any) || "medium",
          summary: args.summary ? String(args.summary) : undefined,
        },
      },
    };
  }

  // ── Integration tools — dispatched via the AI service's execute endpoint ──
  // Tool name shape: `integration.<catalogToolSlug>`. We resolve the slug
  // back to a TenantTool row for this tenant, then POST to ai's
  // /api/ai-assist/:conversationId/tools/execute which handles the HTTP
  // call to the third-party API (Zoho/HubSpot/etc.) plus credentials,
  // audit, and usage tracking.
  // OpenAI function names must match ^[a-zA-Z0-9_-]+$ — dots are rejected —
  // so we use underscore as the prefix separator. The catalog slug itself
  // (after the first underscore) is already in snake_case per our seed.
  if (name?.startsWith("integration_")) {
    const slug = name.slice("integration_".length);
    if (!ctx.conversationId) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "integration tools require a conversation context" }),
      };
    }
    try {
      const { prisma } = await import("./prisma");
      const tenantTool = await prisma.tenantTool.findFirst({
        where: {
          tenantId: ctx.tenantId,
          isEnabled: true,
          tenantIntegration: { status: "CONNECTED" },
          catalogTool: { slug },
        },
        select: { id: true },
      });
      if (!tenantTool) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: false, error: `no connected tool for slug "${slug}"` }),
        };
      }

      const base = (process.env.AI_SERVICE_URL || "http://ai:4006").replace(/\/$/, "");
      const token = ctx.authToken ?? process.env.INTERNAL_SERVICE_TOKEN ?? process.env.INTERNAL_SERVICE_KEY;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
      headers["x-tenant-id"] = ctx.tenantId;

      const res = await fetch(
        `${base}/api/ai-assist/${encodeURIComponent(ctx.conversationId)}/tools/execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ tenantToolId: tenantTool.id, input: args }),
        },
      );
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: false, error: json?.error || `upstream ${res.status}` }),
        };
      }
      const exec = json?.data;
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify(
          exec?.ok
            ? { ok: true, result: exec.output }
            : { ok: false, error: exec?.error || "tool execution failed", status: exec?.status },
        ),
      };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: err?.message ?? "integration dispatch failed" }),
      };
    }
  }

  return {
    toolCallId: toolCall.id,
    content: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }),
  };
}

/**
 * Lightweight human-readable summary of a tool call for the approval
 * card. Stays a plain string — no LLM call, no localization, no fancy
 * formatting. The rich card in the inbox renders richer UI from the
 * raw (tool, params); this is just the "one-sentence first line"
 * fallback for lists and notifications.
 */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const preview = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return preview ? `${name}(${preview})` : `${name}()`;
}
