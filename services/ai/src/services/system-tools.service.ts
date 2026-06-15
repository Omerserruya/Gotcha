/**
 * System Copilot - read-only system tools + propose_plan.
 *
 * These tools are EXCLUSIVE to the System Copilot (Command Center). They
 * do not appear in the customer-bot tool surface. All system_* tools are
 * read-only and tenant-scoped. `propose_plan` is the agent's escape hatch
 * for risky multi-step operations: it creates an ApprovalRequest backed
 * by the existing action-planner /execute path so the human approval UI
 * Just Works.
 *
 * Why a separate file: keeping these out of `packages/shared/agent-tools.ts`
 * stops them from leaking into the customer bot's tool surface and keeps
 * operator-side semantics isolated.
 */

import { prisma } from "@chatcenter/shared";
import {
  buildAgentToolsForAIAgent,
  evaluateToolGate,
  dispatchToolCall,
} from "@chatcenter/shared";
import type { AgentToolContext } from "@chatcenter/shared";
import { createApprovalRequest } from "@chatcenter/shared";

// ─── Tool schemas (OpenAI function-calling format) ──────────

const SYSTEM_COUNT_CONVERSATIONS = {
  type: "function" as const,
  function: {
    name: "system_count_conversations",
    description:
      "Count conversations in the current tenant, optionally filtered by status, channel, or a time window. " +
      "Use for questions like 'how many open conversations do we have?' or 'how many WhatsApp chats this week?'.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["OPEN", "WAITING", "CLOSED", "ANY"],
          description: "Filter by conversation status. Default: ANY.",
        },
        channel: {
          type: "string",
          description:
            "Channel filter (WHATSAPP / MESSENGER / INSTAGRAM / EMAIL / GMAIL / OUTLOOK / SLACK / VOICE / WEBCHAT). Omit for all.",
        },
        sinceISO: {
          type: "string",
          description: "Lower bound for createdAt as an ISO 8601 timestamp. Omit for no lower bound.",
        },
      },
    },
  },
};

const SYSTEM_GET_METRIC = {
  type: "function" as const,
  function: {
    name: "system_get_metric",
    description:
      "Fetch a high-level metric for the tenant. Available metrics: " +
      "'inbound_messages_24h' (count of inbound messages in the last 24h), " +
      "'open_conversations' (currently OPEN), " +
      "'waiting_conversations' (currently WAITING), " +
      "'closed_today' (closed since 00:00 today UTC), " +
      "'pending_approvals' (ApprovalRequest rows still PENDING).",
    parameters: {
      type: "object",
      required: ["metric"],
      properties: {
        metric: {
          type: "string",
          enum: [
            "inbound_messages_24h",
            "open_conversations",
            "waiting_conversations",
            "closed_today",
            "pending_approvals",
          ],
        },
      },
    },
  },
};

const SYSTEM_SEARCH_CUSTOMERS = {
  type: "function" as const,
  function: {
    name: "system_search_customers",
    description:
      "Search contacts in this tenant by name, email, or phone substring. Returns up to 20 matches with id, displayName, channel, email, phone. " +
      "Use to look up a customer the operator referenced by name.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Substring to match against displayName, email, or phone." },
        limit: { type: "number", description: "Cap on results (1–20). Default 10." },
      },
    },
  },
};

const SYSTEM_SUMMARIZE_CONVERSATION = {
  type: "function" as const,
  function: {
    name: "system_summarize_conversation",
    description:
      "Fetch the last N messages of a conversation so you can summarise it. " +
      "If `conversationId` is omitted, uses the conversation currently selected in the UI (from context).",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        limit: { type: "number", description: "Messages to fetch, default 30, max 100." },
      },
    },
  },
};

const SYSTEM_RECENT_ACTIVITY = {
  type: "function" as const,
  function: {
    name: "system_recent_activity",
    description:
      "List recent inbound activity across the tenant: last N inbound messages with timestamp, customer, and snippet. " +
      "Useful for 'what's new today' / triage questions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many messages to return, max 50, default 20." },
      },
    },
  },
};

const PROPOSE_PLAN_TOOL = {
  type: "function" as const,
  function: {
    name: "propose_plan",
    description:
      "Bundle a multi-step or risky operation into an approval plan. The platform will surface it in the operator's approval queue; the operator clicks Approve to execute the steps via the action-planner runtime. " +
      "Use this for: building/scheduling broadcasts, bulk tagging, workflow creation, refunds, anything destructive, or when you want a human to review before mutating data. " +
      "Do NOT use this for read-only operations or single low-risk actions (those you can call directly).",
    parameters: {
      type: "object",
      required: ["summary", "steps"],
      properties: {
        summary: { type: "string", description: "One-sentence summary of what the plan accomplishes." },
        requiresApproval: {
          type: "boolean",
          description: "Hint to the executor. Always treated as `true` if any step is high-risk.",
        },
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["tool", "params", "reason"],
            properties: {
              tool: {
                type: "string",
                description:
                  "An action-planner tool name (send_message, create_broadcast, update_crm, update_contact, create_ticket, create_task, schedule_followup, tag_contact, schedule_broadcast, create_workflow, merge_contacts, resolve_identity).",
              },
              params: { type: "object", description: "Tool-specific parameters." },
              reason: { type: "string", description: "Why this step is included." },
              riskLevel: { type: "string", enum: ["low", "medium", "high"] },
            },
          },
        },
      },
    },
  },
};

// ─── Tool surface for the System Copilot ────────────────────

/**
 * Build the operator-side tool surface:
 *  - Every tenant integration tool the agent has been granted (we use the
 *    seeded "system" agent's row, falling back to "all enabled" when no
 *    grants exist for the operator-tenant pair).
 *  - All system_* read tools above.
 *  - propose_plan.
 *
 * Returns shapes ready for chat.completions.create({ tools }).
 */
export async function buildSystemAgentTools(opts: {
  tenantId: string;
  /** Optional AIAgent ID to inherit per-agent tool grants. If omitted we
   * fall back to "every TenantTool that's enabled and CONNECTED" so the
   * Command Center is useful out of the box on a fresh tenant. */
  aiAgentId?: string | null;
}): Promise<Array<Record<string, unknown>>> {
  const integrationTools = opts.aiAgentId
    ? await buildAgentToolsForAIAgent(opts.tenantId, opts.aiAgentId, {
        identityLinking: false,
        escalation: false,
      })
    : await loadAllTenantIntegrationTools(opts.tenantId);

  return [
    ...integrationTools,
    SYSTEM_COUNT_CONVERSATIONS,
    SYSTEM_GET_METRIC,
    SYSTEM_SEARCH_CUSTOMERS,
    SYSTEM_SUMMARIZE_CONVERSATION,
    SYSTEM_RECENT_ACTIVITY,
    PROPOSE_PLAN_TOOL,
  ];
}

async function loadAllTenantIntegrationTools(
  tenantId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await prisma.tenantTool.findMany({
      where: {
        tenantId,
        isEnabled: true,
        tenantIntegration: { status: "CONNECTED" },
      },
      include: { catalogTool: true },
    });
    return rows.map((r: any) => {
      const ct = r.catalogTool;
      const parameters =
        ct.inputSchema && typeof ct.inputSchema === "object" && !Array.isArray(ct.inputSchema)
          ? ct.inputSchema
          : { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name: `integration_${ct.slug}`,
          description: ct.description || ct.name,
          parameters,
        },
      };
    });
  } catch (err: any) {
    console.warn("[system-tools] integration load failed:", err?.message);
    return [];
  }
}

// ─── Dispatcher ─────────────────────────────────────────────

export interface SystemToolDispatchCtx {
  tenantId: string;
  userId: string;
  /** Resolved from agent-context.service. */
  selectedConversationId?: string | null;
  selectedContactId?: string | null;
  /** Pass-through for downstream services (Bearer). */
  authToken?: string;
}

export interface SystemToolResult {
  toolCallId: string;
  /** JSON-stringified result fed back into the chat loop. */
  content: string;
  /** Surfaced to the route layer for SSE event emission. */
  sideEffect?:
    | { kind: "proposed_plan"; approvalRequestId: string; planSummary: string }
    | { kind: "denied"; tool: string; reason: string }
    | { kind: "awaiting_approval"; approvalRequestId: string; tool: string };
}

/**
 * Dispatch a single tool call. system_* tools and propose_plan are handled
 * locally; everything else delegates to `dispatchToolCall` so HITL gating
 * (evaluateToolGate) and the standard audit trail apply identically.
 */
export async function dispatchSystemToolCall(
  toolCall: { id: string; function: { name: string; arguments: string } },
  ctx: SystemToolDispatchCtx,
): Promise<SystemToolResult> {
  const name = toolCall.function?.name || "";
  let args: any = {};
  try {
    args = JSON.parse(toolCall.function?.arguments || "{}");
  } catch {
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({ ok: false, error: "invalid JSON arguments" }),
    };
  }

  if (name.startsWith("system_")) {
    return dispatchSystemTool(name, args, toolCall.id, ctx);
  }
  if (name === "propose_plan") {
    return dispatchProposePlan(args, toolCall.id, ctx);
  }

  // Everything else (integration_*, link_customer_identifier, escalate_to_human,
  // tag_contact, etc.) flows through the universal dispatcher with the same
  // gate, dedupe, and audit logic the customer bot uses.
  const agentCtx: AgentToolContext = {
    tenantId: ctx.tenantId,
    conversationId: ctx.selectedConversationId ?? undefined,
    contactId: ctx.selectedContactId ?? undefined,
    authToken: ctx.authToken,
    mode: "agent",
  };
  const r = await dispatchToolCall(toolCall, agentCtx);
  if (r.sideEffect?.awaitingApproval) {
    return {
      toolCallId: r.toolCallId,
      content: r.content,
      sideEffect: {
        kind: "awaiting_approval",
        approvalRequestId: r.sideEffect.awaitingApproval.approvalRequestId,
        tool: r.sideEffect.awaitingApproval.tool,
      },
    };
  }
  if (r.sideEffect?.denied) {
    return {
      toolCallId: r.toolCallId,
      content: r.content,
      sideEffect: { kind: "denied", tool: r.sideEffect.denied.tool, reason: r.sideEffect.denied.reason },
    };
  }
  return { toolCallId: r.toolCallId, content: r.content };
}

// ─── system_* implementations ───────────────────────────────

async function dispatchSystemTool(
  name: string,
  args: any,
  toolCallId: string,
  ctx: SystemToolDispatchCtx,
): Promise<SystemToolResult> {
  try {
    switch (name) {
      case "system_count_conversations": {
        const where: any = { tenantId: ctx.tenantId };
        if (args.status && args.status !== "ANY") where.status = args.status;
        if (args.channel) where.channel = args.channel;
        if (args.sinceISO) where.createdAt = { gte: new Date(args.sinceISO) };
        const count = await prisma.conversation.count({ where });
        return { toolCallId, content: JSON.stringify({ ok: true, count, where }) };
      }
      case "system_get_metric": {
        const value = await getMetric(ctx.tenantId, args.metric);
        return { toolCallId, content: JSON.stringify({ ok: true, metric: args.metric, value }) };
      }
      case "system_search_customers": {
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
        const q = String(args.query || "").trim();
        if (!q) {
          return { toolCallId, content: JSON.stringify({ ok: false, error: "query is required" }) };
        }
        const rows = await prisma.contact.findMany({
          where: {
            tenantId: ctx.tenantId,
            OR: [
              { displayName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
            ],
          },
          take: limit,
          select: { id: true, displayName: true, channel: true, email: true, phone: true },
        });
        return { toolCallId, content: JSON.stringify({ ok: true, results: rows }) };
      }
      case "system_summarize_conversation": {
        const cid = args.conversationId || ctx.selectedConversationId;
        if (!cid) {
          return {
            toolCallId,
            content: JSON.stringify({
              ok: false,
              error: "no conversation selected - pass conversationId or open one in the UI",
            }),
          };
        }
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const messages = await prisma.message.findMany({
          where: { tenantId: ctx.tenantId, conversationId: cid },
          orderBy: { createdAt: "asc" },
          take: limit,
          select: { direction: true, body: true, createdAt: true, senderName: true },
        });
        return {
          toolCallId,
          content: JSON.stringify({
            ok: true,
            conversationId: cid,
            messageCount: messages.length,
            messages: messages.map((m) => ({
              at: m.createdAt.toISOString(),
              role: m.direction === "INBOUND" ? "customer" : "agent",
              by: m.senderName || null,
              body: (m.body || "").slice(0, 600),
            })),
          }),
        };
      }
      case "system_recent_activity": {
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
        const rows = await prisma.message.findMany({
          where: { tenantId: ctx.tenantId, direction: "INBOUND" },
          orderBy: { createdAt: "desc" },
          take: limit,
          select: {
            conversationId: true,
            body: true,
            createdAt: true,
            conversation: {
              select: { customerName: true, customerExternalId: true, channel: true },
            },
          },
        });
        return {
          toolCallId,
          content: JSON.stringify({
            ok: true,
            results: rows.map((m) => ({
              at: m.createdAt.toISOString(),
              conversationId: m.conversationId,
              channel: (m as any).conversation?.channel,
              who:
                (m as any).conversation?.customerName ||
                (m as any).conversation?.customerExternalId ||
                "unknown",
              body: (m.body || "").slice(0, 200),
            })),
          }),
        };
      }
      default:
        return { toolCallId, content: JSON.stringify({ ok: false, error: `unknown system tool: ${name}` }) };
    }
  } catch (err: any) {
    console.error(`[system-tools] ${name} failed:`, err?.message);
    return { toolCallId, content: JSON.stringify({ ok: false, error: err?.message || "tool error" }) };
  }
}

async function getMetric(tenantId: string, metric: string): Promise<number> {
  const now = new Date();
  switch (metric) {
    case "inbound_messages_24h": {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      return prisma.message.count({
        where: { tenantId, direction: "INBOUND", createdAt: { gte: since } },
      });
    }
    case "open_conversations":
      return prisma.conversation.count({ where: { tenantId, status: "OPEN" } });
    case "waiting_conversations":
      return prisma.conversation.count({ where: { tenantId, status: "WAITING" } });
    case "closed_today": {
      const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
      return prisma.conversation.count({
        where: { tenantId, status: "CLOSED", closedAt: { gte: startOfDay } },
      });
    }
    case "pending_approvals":
      return (prisma as any).approvalRequest.count({ where: { tenantId, status: "PENDING" } });
    default:
      return 0;
  }
}

// ─── propose_plan ───────────────────────────────────────────

async function dispatchProposePlan(
  args: any,
  toolCallId: string,
  ctx: SystemToolDispatchCtx,
): Promise<SystemToolResult> {
  const summary = String(args?.summary || "").trim();
  const stepsRaw = Array.isArray(args?.steps) ? args.steps : [];
  if (!summary || stepsRaw.length === 0) {
    return {
      toolCallId,
      content: JSON.stringify({ ok: false, error: "summary and at least one step are required" }),
    };
  }

  const steps = stepsRaw.map((s: any) => ({
    tool: String(s?.tool || ""),
    params: s?.params && typeof s.params === "object" ? s.params : {},
    reason: String(s?.reason || ""),
    riskLevel: ["low", "medium", "high"].includes(s?.riskLevel) ? s.riskLevel : "medium",
  }));

  const requiresApproval =
    args?.requiresApproval === true || steps.some((s: any) => s.riskLevel === "high");

  // Audit each step's gate decision so the operator's approval UI can show
  // an aggregate "needs approval / cleared" status. We don't actually
  // execute anything here - the existing approval-resume path in the
  // conversation service runs the steps when the human clicks Approve.
  const stepGates = await Promise.all(
    steps.map(async (s: any) => {
      try {
        const gate = await evaluateToolGate(ctx.tenantId, s.tool);
        return { tool: s.tool, decision: gate.decision, reason: gate.reason };
      } catch (err: any) {
        return { tool: s.tool, decision: "DENY" as const, reason: err?.message || "gate error" };
      }
    }),
  );

  const approval = await createApprovalRequest({
    tenantId: ctx.tenantId,
    contactId: ctx.selectedContactId ?? undefined,
    conversationId: ctx.selectedConversationId ?? undefined,
    tool: "propose_plan",
    params: { summary, steps, requiresApproval, source: "system_copilot" },
    summary,
    reason: "Plan proposed by System Copilot",
    riskLevel: requiresApproval ? "high" : "medium",
    riskTags: ["SYSTEM_COPILOT", "PLAN"],
    requestedBy: "bot",
    gate: { decision: "REQUIRE_APPROVAL", reason: "system copilot plan" } as any,
  });

  return {
    toolCallId,
    content: JSON.stringify({
      ok: true,
      proposed_plan: true,
      approval_request_id: approval.id,
      step_count: steps.length,
      step_gates: stepGates,
      instruction:
        "A plan was proposed and is waiting in the operator's approval queue. Tell the operator briefly what you proposed and that they can review and approve it. Do NOT continue calling action tools for the same goal.",
    }),
    sideEffect: {
      kind: "proposed_plan",
      approvalRequestId: approval.id,
      planSummary: summary,
    },
  };
}
