/**
 * Memory tools — AI-callable surface for customer state + history.
 *
 * Five tools wired into the existing OpenAI-function-calling format:
 *
 *   get_customer_context        Cross-channel bundle: open issues, recent
 *                                summaries, CRM notes, sentiment trend.
 *                                Use at the start of every bot turn.
 *   search_customer_history     Keyword search across this customer's prior
 *                                messages + AI summaries (cross-channel).
 *   get_open_issues             Just the open CRM tasks for this customer.
 *                                Returns the same data get_customer_context
 *                                does but as a focused tool for "is there
 *                                anything outstanding?" prompts.
 *   schedule_message            Create a ScheduledMessage row that the
 *                                existing scheduled-message worker will
 *                                process at runAt. No new infra.
 *   schedule_flow_trigger       Same as above but populates `flowId` so the
 *                                worker dispatches to the flow executor.
 *                                (The flow-trigger branch was wired into
 *                                scheduled.worker.ts in this same change.)
 *
 * Every WRITE tool dedupes via a deterministic key on the ScheduledMessage
 * row — two AI calls with the same conversationId + body + minute-truncated
 * runAt collapse to one job.
 *
 * Read tools never block: CRM unreachable → empty arrays + reason flag.
 * Write tools refuse cleanly when the conversation isn't found.
 */

import { prisma } from "@chatcenter/shared";
import crypto from "crypto";
import { loadCustomerContext } from "./customer-context.service";

// ─── Tool schemas (OpenAI function-calling format) ──────────

export const GET_CUSTOMER_CONTEXT_TOOL = {
  type: "function" as const,
  function: {
    name: "get_customer_context",
    description:
      "Return what GOTCHA + the CRM remember about this customer right now: " +
      "open issues (incomplete CRM tasks), recent AI summaries of prior " +
      "conversations across every channel, recent CRM notes, and sentiment " +
      "trend. Call this at the start of a turn before deciding how to respond.",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Current conversation id." },
      },
      required: ["conversationId"],
    },
  },
};

export const SEARCH_CUSTOMER_HISTORY_TOOL = {
  type: "function" as const,
  function: {
    name: "search_customer_history",
    description:
      "Keyword search across this customer's prior messages and AI summaries " +
      "across every channel they've used. Use when you need to recall a " +
      "specific topic the customer mentioned before (e.g. 'did they ever " +
      "mention refund?'). Returns matched excerpts with channel + timestamp.",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Current conversation id (used to resolve the customer)." },
        query: { type: "string", description: "Free-text search query." },
        limit: { type: "number", description: "Max hits (default 10, max 25)." },
      },
      required: ["conversationId", "query"],
    },
  },
};

export const GET_OPEN_ISSUES_TOOL = {
  type: "function" as const,
  function: {
    name: "get_open_issues",
    description:
      "List CRM open issues (incomplete tasks) for this customer. Use to " +
      "check whether the customer is waiting on something (refund, callback, " +
      "promised quote) before making new commitments.",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
      },
      required: ["conversationId"],
    },
  },
};

export const SCHEDULE_MESSAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "schedule_message",
    description:
      "Queue an outbound message to the customer for a future time. Use for " +
      "followups, reminders, retention nudges. The existing scheduled-message " +
      "worker handles delivery + opt-out checks. Returns the scheduled row id " +
      "(can be cancelled via DELETE /api/scheduled-messages/:id).",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        body: { type: "string", description: "Message body to send at runAt." },
        runAt: { type: "string", description: "ISO 8601 timestamp; must be in the future." },
      },
      required: ["conversationId", "body", "runAt"],
    },
  },
};

export const SCHEDULE_FLOW_TRIGGER_TOOL = {
  type: "function" as const,
  function: {
    name: "schedule_flow_trigger",
    description:
      "Schedule a chatbot flow to start for this conversation at a future " +
      "time. Use for time-based engagement like 'kick the retention flow if " +
      "the customer goes silent for 7 days'. The flow runs against the same " +
      "conversation scope with the `body` text available as the inbound payload.",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        flowId: { type: "string", description: "ChatbotFlow id to trigger." },
        runAt: { type: "string", description: "ISO 8601 timestamp; must be in the future." },
        body: { type: "string", description: "Optional kick text the flow can read as the inbound message." },
      },
      required: ["conversationId", "flowId", "runAt"],
    },
  },
};

export const MEMORY_TOOL_SCHEMAS = [
  GET_CUSTOMER_CONTEXT_TOOL,
  SEARCH_CUSTOMER_HISTORY_TOOL,
  GET_OPEN_ISSUES_TOOL,
  SCHEDULE_MESSAGE_TOOL,
  SCHEDULE_FLOW_TRIGGER_TOOL,
];

// ─── Tool executor ──────────────────────────────────────────

export interface MemoryToolContext {
  tenantId: string;
  /** When provided, used as createdBy for ScheduledMessage. AI-driven calls
   *  pass a stable "ai" id; agent-driven calls pass the user id. */
  actorId: string;
  /** Free-form audit label; appears in audit_logs.metadata.source. */
  source?: string;
}

export interface MemoryToolResult {
  ok: boolean;
  data?: unknown;
  reason?: string;
}

export async function executeMemoryTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
  switch (toolName) {
    case "get_customer_context":
      return getCustomerContextTool(args, ctx);
    case "search_customer_history":
      return searchCustomerHistoryTool(args, ctx);
    case "get_open_issues":
      return getOpenIssuesTool(args, ctx);
    case "schedule_message":
      return scheduleMessageTool(args, ctx);
    case "schedule_flow_trigger":
      return scheduleFlowTriggerTool(args, ctx);
    default:
      return { ok: false, reason: `unknown_tool:${toolName}` };
  }
}

// ─── Read tools ────────────────────────────────────────────

async function getCustomerContextTool(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<MemoryToolResult> {
  const conversationId = String(args.conversationId ?? "");
  if (!conversationId) return { ok: false, reason: "conversationId_required" };
  const bundle = await loadCustomerContext({ tenantId: ctx.tenantId, conversationId });
  return { ok: true, data: bundle };
}

async function searchCustomerHistoryTool(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<MemoryToolResult> {
  const conversationId = String(args.conversationId ?? "");
  const query = String(args.query ?? "").trim();
  const limit = Math.min(Number(args.limit ?? 10), 25);
  if (!conversationId || !query) return { ok: false, reason: "conversationId_and_query_required" };

  // Resolve the customer's GOTCHA Contact identity for cross-channel walk.
  const conv = await (prisma as any).conversation.findFirst({
    where: { id: conversationId, tenantId: ctx.tenantId },
    select: { channel: true, customerExternalId: true },
  });
  if (!conv) return { ok: false, reason: "conversation_not_found" };

  // Find sibling conversations (same customer across channels) via CRM pin.
  const myContact = await (prisma as any).contact.findFirst({
    where: { tenantId: ctx.tenantId, channel: conv.channel, externalId: conv.customerExternalId },
    select: { metadata: true },
  });
  const crmContactId = ((myContact?.metadata ?? {}) as any)?.crmContactId ?? null;

  let convFilter: any = { tenantId: ctx.tenantId, channel: conv.channel, customerExternalId: conv.customerExternalId };
  if (crmContactId) {
    const siblings = await (prisma as any).contact.findMany({
      where: { tenantId: ctx.tenantId, metadata: { path: ["crmContactId"], equals: crmContactId } },
      select: { channel: true, externalId: true },
    });
    if (siblings.length > 0) {
      convFilter = {
        tenantId: ctx.tenantId,
        OR: siblings.map((s: any) => ({ channel: s.channel, customerExternalId: s.externalId })),
      };
    }
  }

  const sibConvs = await (prisma as any).conversation.findMany({
    where: convFilter,
    select: { id: true, channel: true, createdAt: true },
  });
  const sibConvIds = sibConvs.map((c: any) => c.id);
  if (sibConvIds.length === 0) return { ok: true, data: { hits: [] } };

  // Keyword search across messages (Postgres ILIKE for now — pg_trgm + Qdrant
  // come in a later phase; ILIKE is fine for the first cut).
  const escaped = query.replace(/[%_]/g, "\\$&");
  const matches = await (prisma as any).message.findMany({
    where: {
      tenantId: ctx.tenantId,
      conversationId: { in: sibConvIds },
      body: { contains: escaped, mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, conversationId: true, body: true, direction: true, createdAt: true },
  });

  const convById = new Map<string, any>(sibConvs.map((c: any) => [c.id, c]));
  const hits = matches.map((m: any) => ({
    source: "message",
    messageId: m.id,
    conversationId: m.conversationId,
    channel: convById.get(m.conversationId)?.channel ?? "unknown",
    direction: m.direction,
    excerpt: String(m.body || "").slice(0, 240),
    occurred_at: m.createdAt,
  }));

  return { ok: true, data: { hits, total: hits.length } };
}

async function getOpenIssuesTool(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<MemoryToolResult> {
  const conversationId = String(args.conversationId ?? "");
  if (!conversationId) return { ok: false, reason: "conversationId_required" };
  const bundle = await loadCustomerContext({ tenantId: ctx.tenantId, conversationId });
  return { ok: true, data: { open_issues: bundle.open_issues, count: bundle.open_issues.length } };
}

// ─── Write tools ───────────────────────────────────────────

function dedupKey(parts: (string | number | undefined)[]): string {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex");
}

async function loadConvOrFail(conversationId: string, tenantId: string) {
  const conv = await (prisma as any).conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, channel: true, channelAccountId: true, customerExternalId: true },
  });
  return conv;
}

async function scheduleMessageTool(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<MemoryToolResult> {
  const conversationId = String(args.conversationId ?? "");
  const body = String(args.body ?? "").trim();
  const runAtIso = String(args.runAt ?? "");
  if (!conversationId || !body || !runAtIso) return { ok: false, reason: "missing_required" };
  const runAt = new Date(runAtIso);
  if (Number.isNaN(runAt.getTime()) || runAt <= new Date()) return { ok: false, reason: "runAt_must_be_future" };

  const conv = await loadConvOrFail(conversationId, ctx.tenantId);
  if (!conv) return { ok: false, reason: "conversation_not_found" };

  // Dedup: same conv + body + minute-truncated runAt collapses.
  const minuteIso = new Date(Math.floor(runAt.getTime() / 60000) * 60000).toISOString();
  const dk = dedupKey([ctx.tenantId, conversationId, "msg", body.slice(0, 64), minuteIso]);

  const existing = await (prisma as any).scheduledMessage.findFirst({
    where: { tenantId: ctx.tenantId, status: "PENDING", variables: { path: ["_gotchaDedupKey"], equals: dk } },
    select: { id: true },
  });
  if (existing) return { ok: true, data: { scheduledMessageId: existing.id, deduped: true } };

  const created = await (prisma as any).scheduledMessage.create({
    data: {
      tenantId: ctx.tenantId,
      channel: conv.channel,
      channelAccountId: conv.channelAccountId,
      recipientExternalId: conv.customerExternalId,
      body,
      conversationId,
      scheduledAt: runAt,
      createdBy: ctx.actorId,
      status: "PENDING",
      variables: { _gotchaDedupKey: dk, _source: ctx.source ?? "ai_tool" },
    },
    select: { id: true },
  });
  return { ok: true, data: { scheduledMessageId: created.id, deduped: false } };
}

async function scheduleFlowTriggerTool(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<MemoryToolResult> {
  const conversationId = String(args.conversationId ?? "");
  const flowId = String(args.flowId ?? "");
  const runAtIso = String(args.runAt ?? "");
  const body = String(args.body ?? "").trim() || "";
  if (!conversationId || !flowId || !runAtIso) return { ok: false, reason: "missing_required" };
  const runAt = new Date(runAtIso);
  if (Number.isNaN(runAt.getTime()) || runAt <= new Date()) return { ok: false, reason: "runAt_must_be_future" };

  const conv = await loadConvOrFail(conversationId, ctx.tenantId);
  if (!conv) return { ok: false, reason: "conversation_not_found" };

  // Verify flow belongs to tenant + is active before scheduling — cheap
  // guardrail against typos / cross-tenant ids.
  const flow = await (prisma as any).chatbotFlow.findFirst({
    where: { id: flowId, tenantId: ctx.tenantId, isActive: true },
    select: { id: true },
  });
  if (!flow) return { ok: false, reason: "flow_not_found_or_inactive" };

  const minuteIso = new Date(Math.floor(runAt.getTime() / 60000) * 60000).toISOString();
  const dk = dedupKey([ctx.tenantId, conversationId, "flow", flowId, minuteIso]);

  const existing = await (prisma as any).scheduledMessage.findFirst({
    where: { tenantId: ctx.tenantId, status: "PENDING", flowId, variables: { path: ["_gotchaDedupKey"], equals: dk } },
    select: { id: true },
  });
  if (existing) return { ok: true, data: { scheduledMessageId: existing.id, deduped: true } };

  const created = await (prisma as any).scheduledMessage.create({
    data: {
      tenantId: ctx.tenantId,
      channel: conv.channel,
      channelAccountId: conv.channelAccountId,
      recipientExternalId: conv.customerExternalId,
      body: body || `[flow:${flowId}]`,
      conversationId,
      flowId,
      scheduledAt: runAt,
      createdBy: ctx.actorId,
      status: "PENDING",
      variables: { _gotchaDedupKey: dk, _source: ctx.source ?? "ai_tool", _flowTrigger: true },
    },
    select: { id: true },
  });
  return { ok: true, data: { scheduledMessageId: created.id, deduped: false } };
}
