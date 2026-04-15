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
}

export interface AgentToolSideEffect {
  /** escalate_to_human was requested — caller must hand off to human. */
  escalate?: {
    reason: string;
    priority?: "low" | "medium" | "high";
    summary?: string;
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
}

export function buildAgentTools(opts: BuildAgentToolsOptions = {}): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (opts.identityLinking !== false) tools.push(LINK_IDENTIFIER_TOOL as any);
  if (opts.escalation !== false) tools.push(ESCALATE_TOOL as any);
  if (opts.extra?.length) tools.push(...opts.extra);
  return tools;
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

  return {
    toolCallId: toolCall.id,
    content: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }),
  };
}
