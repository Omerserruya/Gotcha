/**
 * Autonomous AI bot reply generator (server-side).
 *
 * SOLE owner of the LLM call for the autonomous "/agent" mode. Every turn:
 *   1. Collect runtime data (agent, conversation, history, CRM, approvals).
 *   2. Compute BehaviorState (BEL is the ONLY decision layer).
 *   3. Build the system prompt (PB consumes BehaviorState; never decides).
 *   4. Filter tools using ONLY `state.allowedActions` — no ad-hoc filters.
 *   5. Run the tool-calling loop.
 *   6. Audit BehaviorState (with provenance) + tool calls.
 *
 * Spec rule #2: tool availability comes ONLY from BehaviorState.allowedActions.
 * Spec rule #3: KB retrieval is gated ONLY by `shouldRetrieveKB(state, ...)`.
 */

import { prisma, buildAgentToolsForAIAgent, dispatchToolCall } from "@chatcenter/shared";
import type { AgentToolDispatchResult } from "@chatcenter/shared";
import { randomUUID } from "crypto";
import { getActionOrchestrator, type ExecutionResult } from "./orchestrator";
import type { AgentToolContext } from "@chatcenter/shared";
import { generateResponse } from "./ai.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";
import { prefetchCrmContext, renderCrmContextBlock } from "./crm-prefetch.service";
import {
  buildAgentPrompt,
  renderOutputContractInstruction,
  type AgentRecord,
  type ContextSlot,
} from "./prompt-builder.service";
import {
  computeBehaviorState,
  shouldRetrieveKB,
  type BehaviorState,
  type LastAssistantMove,
} from "./behavior-engine.service";
import type { ActionCategory } from "./behavior-strategies";
import {
  buildConversationMemory,
  renderMemoryBlock,
} from "./conversation-memory.service";
import { loadFunnelForTenant } from "./funnel-config.repo";
import { makeScheduleMeetingHandler } from "./schedule-handler.service";
import { listCustomApiTools, executeCustomApiTool } from "./connectors/custom-api.service";
import { executeAdapterTool, listAdapters } from "./connectors/integration-framework";
import {
  loadActionContracts,
  loadContractProgress,
  markContractToolCompleted,
  markContractPaused,
  type ActionContract,
} from "./action-contracts.repo";
import { tryEmit } from "./notifications-emit";
import type { SystemEventType } from "./notifications-emit";

/**
 * Phase 4: every chat tool call funnels through the ActionOrchestrator
 * for policy + audit + retry/CB/DLQ. This helper maps the orchestrator's
 * ExecutionResult back to the AgentToolDispatchResult shape the existing
 * chat loop reads (`result.content`, `result.sideEffect.{awaitingApproval,denied,escalate}`).
 *
 * Auto-executed completions return the underlying dispatch result verbatim,
 * preserving the dispatcher's own approval-gate side effects. Orchestrator-
 * level deny/propose decisions synthesize a side-effect shape that triggers
 * the existing chat loop's pause/handoff branches without new branches.
 */
function unwrapToolExec(
  toolCallId: string,
  toolName: string,
  exec: ExecutionResult,
): AgentToolDispatchResult {
  if (exec.status === "completed") {
    const inner = exec.result as AgentToolDispatchResult | undefined;
    if (inner && typeof inner === "object" && "content" in inner) return inner;
    // Defensive default if executor returned a non-AgentToolDispatchResult.
    return { toolCallId, content: typeof inner === "string" ? inner : "" };
  }
  if (exec.status === "proposed") {
    return {
      toolCallId,
      content: `Action "${toolName}" requires human approval and has been queued.`,
      sideEffect: {
        awaitingApproval: {
          approvalRequestId: toolCallId,
          tool: toolName,
        } as any,
      },
    };
  }
  if (exec.status === "denied") {
    return {
      toolCallId,
      content: `Action "${toolName}" denied: ${exec.error ?? "policy"}`,
      sideEffect: { denied: { reason: exec.error ?? "policy" } as any },
    };
  }
  if (exec.status === "failed") {
    return {
      toolCallId,
      content: `Action "${toolName}" failed: ${exec.error ?? "unknown error"}`,
    };
  }
  return { toolCallId, content: "" };
}

// Map a tool function name to a SystemEvent type (when applicable).
// Names are matched as `slug.tool` — the slug part is preserved for context
// in the event data. We only emit on success; failed/denied calls are noisy.
function classifyToolForNotification(toolFunctionName: string): SystemEventType | null {
  const lower = toolFunctionName.toLowerCase();
  if (lower.includes("refund")) return "refund.issued";
  if (lower.includes("discount")) return "discount.applied";
  if (lower.includes("schedule_meeting") || lower.includes("book_meeting") || lower.startsWith("book_")) return "meeting.scheduled";
  return null;
}

export interface AIBotReplyResult {
  reply: string | null;
  escalation: { reason: string; priority?: "low" | "medium" | "high"; summary?: string } | null;
  awaitingApproval: { approvalRequestId: string; tool: string; reason: string } | null;
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    decision?: string;
    sideEffect?: string;
  }>;
  modelUsed: string;
  totalTokens: number;
}

function toAgentRecord(row: any): AgentRecord {
  return {
    name: row.name,
    role: row.role,
    description: row.description,
    tone: row.tone,
    style: row.style,
    identity: row.identity,
    goals: row.goals,
    toneConfig: row.toneConfig,
    behavioral: row.behavioral,
    persona: row.persona,
    conversationFlow: row.conversationFlow,
    customGuardrails: row.customGuardrails,
    escalationRules: row.escalationRules,
    behavioralAnchors: row.behavioralAnchors,
  };
}

/**
 * Build the autonomous-mode system prompt with no runtime context.
 * Used by debug + one-shot calls. Synthesises a minimal initial-turn state.
 */
export async function buildAgentSystemPrompt(rawAgent: any): Promise<string> {
  const behaviorState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: "", messageCount: 1 },
  });
  return buildAgentPrompt({
    behaviorState,
    agent: toAgentRecord(rawAgent),
  });
}

/**
 * Detect a human-handoff REQUEST. Must require an action verb context — the
 * customer is asking to talk to a human, not describing their own team.
 *
 * \b doesn't work for Hebrew in JavaScript (non-ASCII letters aren't word
 * characters), so the original `/\b(נציג)\b/` matched inside "נציגים"
 * (12 representatives) and triggered false escalations. Patterns below
 * require a verb of asking/requesting paired with the noun.
 */
const HUMAN_HANDOFF_PATTERNS = [
  // English — explicit request
  /\b(speak|talk|connect|chat|transfer|put me through)\s+(to|with|me)\s+(a\s+)?(human|agent|person|someone|rep|representative)\b/i,
  /\b(can\s+i|i\s+(?:want|need|wanna|would like))\s+(to\s+)?(speak|talk|chat)\s+(to|with)\s+(a\s+)?(human|agent|person|someone|rep)\b/i,
  /\b(give|get|connect)\s+me\s+(to\s+)?(a\s+)?(human|agent|person|rep)\b/i,
  /\bnot\s+a\s+bot\b/i,
  // Hebrew — explicit request only. Word boundaries via space/start/end.
  /(?:^|\s)לדבר עם\s+(אדם|נציג|נציגה|מישהו|בנאדם)/,
  /(?:^|\s)תעבירו אותי\s+(?:ל|אל)\s*(אדם|נציג|נציגה|מישהו)/,
  /(?:^|\s)(?:אני רוצה|אני צריך|תן לי|תני לי|אפשר)\s+(?:לדבר עם\s+)?(אדם|נציג|נציגה|בנאדם|אנושי)(?:\s|$|[.,!?])/,
  /(?:^|\s)נציג\s+(אנושי|אמיתי|בבקשה)(?:\s|$|[.,!?])/,
  /(?:^|\s)(אדם|בנאדם)\s+(אמיתי|אנושי)(?:\s|$|[.,!?])/,
];
function detectHumanHandoff(text: string): boolean {
  if (!text) return false;
  for (const re of HUMAN_HANDOFF_PATTERNS) if (re.test(text)) return true;
  return false;
}

/**
 * Filter the LLM tool surface using ONLY `state.allowedActions`. The BEL
 * has already accounted for strategy, autonomy, CRM existence, and pending
 * approvals; this function performs the deterministic name → category
 * mapping and drops anything outside the allowed set.
 *
 * Always-keep: escalate_to_human, submit_*, integration_*_search/_get/_lookup/_read.
 */
/**
 * Reverse-mapping: which ActionCategory does this tool function name implement?
 * Mirrors the runtime filter logic so the runtime enforcer can detect when a
 * required action had a matching tool but the LLM didn't call it.
 */
function actionCategoriesForTool(toolName: string): ActionCategory[] {
  if (!toolName) return [];
  if (toolName === "escalate_to_human") return ["escalate_to_human"];
  if (toolName === "link_customer_identifier") return ["identity_link"];
  if (toolName.startsWith("submit_")) return [];
  if (/(_search|_get|_lookup|_read)$/.test(toolName)) return ["crm_read", "kb_lookup"];
  if (/^integration_create_lead/.test(toolName)) return ["create_lead"];
  if (/^integration_create_contact/.test(toolName)) return ["create_contact"];
  if (/(_note$|add_note)/.test(toolName)) return ["add_note"];
  if (/(tag_|_tag$)/.test(toolName)) return ["tag"];
  if (/(schedule_followup|set_followup)/.test(toolName)) return ["schedule_followup"];
  if (/(book_|schedule_meeting|schedule_demo)/.test(toolName)) return ["schedule_booking"];
  if (/(send_proposal|send_quote|create_proposal)/.test(toolName)) return ["send_proposal"];
  if (/(update_|patch_)/.test(toolName)) return ["update_record"];
  return [];
}

/**
 * Compute unmet required actions: required ∧ (matching tool was in surface) ∧ (no such tool was called).
 * Returns one entry per missed required action with the concrete tool name the LLM should have called.
 */
function computeUnmetRequiredActions(
  required: ActionCategory[],
  surfaceToolNames: string[],
  toolCallLog: AIBotReplyResult["toolCallLog"],
): Array<{ action: ActionCategory; toolName: string }> {
  const calledToolNames = new Set(toolCallLog.map((t) => t.tool));
  const unmet: Array<{ action: ActionCategory; toolName: string }> = [];

  for (const action of required) {
    // Find the first surface tool that maps to this action.
    const matchingTool = surfaceToolNames.find((fn) => actionCategoriesForTool(fn).includes(action));
    if (!matchingTool) continue; // No tool exists for this action — not a violation.
    // Was any tool that maps to this action called?
    const wasCalled = [...calledToolNames].some((called) => actionCategoriesForTool(called).includes(action));
    if (!wasCalled) unmet.push({ action, toolName: matchingTool });
  }
  return unmet;
}

function filterToolsByAllowedActions(tools: any[], state: BehaviorState): any[] {
  const allowed = new Set<ActionCategory>(state.allowedActions);

  const baseFiltered = tools.filter((t: any) => {
    const name: string | undefined = t?.function?.name;
    if (!name) return true;

    if (name === "escalate_to_human") return true;
    if (name === "link_customer_identifier") return allowed.has("identity_link");
    if (name.startsWith("submit_")) return true;
    if (/(_search|_get|_lookup|_read)$/.test(name)) return true;

    if (/^integration_create_lead/.test(name)) return allowed.has("create_lead");
    if (/^integration_create_contact/.test(name)) return allowed.has("create_contact");
    if (/(update_|patch_)/.test(name)) return allowed.has("update_record");
    if (/(_note$|add_note)/.test(name)) return allowed.has("add_note");
    if (/(tag_|_tag$)/.test(name)) return allowed.has("tag");
    if (/(schedule_followup|set_followup)/.test(name)) return allowed.has("schedule_followup");
    if (/(book_|schedule_meeting|schedule_demo)/.test(name)) return allowed.has("schedule_booking");
    if (/(send_proposal|send_quote|create_proposal)/.test(name)) return allowed.has("send_proposal");

    return allowed.has("update_record");
  });

  // ── Action Contract gate ─────────────────────────────────────
  // When a blocking contract is active, the LLM MUST only see the pending
  // tools (plus essentials). For SEQUENCE contracts, only the next-step
  // tool is exposed — we can't even let the model TRY out-of-order calls
  // because some providers will silently bias toward emitting whatever's
  // in the schema. Stripping the rest is the deterministic fix.
  const cs = state.actionContractState;
  if (!cs?.active || !cs.blocking || cs.pendingTools.length === 0) {
    return baseFiltered;
  }
  const pendingSet = new Set(cs.pendingTools);
  return baseFiltered.filter((t: any) => {
    const name: string | undefined = t?.function?.name;
    if (!name) return true;
    if (name === "escalate_to_human") return true;       // always available
    if (name === "link_customer_identifier") return true; // identity bookkeeping
    if (name.startsWith("submit_")) return true;          // copilot submission
    if (/(_search|_get|_lookup|_read)$/.test(name)) return true; // pure reads
    return pendingSet.has(name);
  });
}

/**
 * Extract an email or phone identifier from THIS turn's inbound message.
 * Returns undefined if neither is present. The BEL uses this to drive the
 * ownership signal + identity_link required action (Task 1).
 */
function extractIdentifierFromMessage(text: string): { kind: "email" | "phone"; value: string } | undefined {
  const trimmed = (text || "").trim();
  if (!trimmed) return undefined;
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const m = trimmed.match(emailRe);
  if (m) return { kind: "email", value: m[0].toLowerCase() };
  // E.164-ish phone — international format only to avoid false positives.
  const phoneRe = /(\+\d[\d\s().-]{7,}\d)/;
  const p = trimmed.match(phoneRe);
  if (p) return { kind: "phone", value: p[1].replace(/[\s()-]/g, "") };
  return undefined;
}

/**
 * Did the assistant's previous turn ask the customer for an email or phone?
 * Cheap text scan over the last assistant message in the history slice.
 */
function detectAssistantAskedFor(
  messages: Array<{ direction: string; body: string | null }>,
): "email" | "phone" | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== "OUTBOUND" || !m.body) continue;
    const lower = m.body.toLowerCase();
    if (/(email|אימייל|מייל|דואר אלקטרוני)/.test(lower) && /\?|\bיכול\b|\bתוכל\b|\bcan you\b/i.test(lower)) {
      return "email";
    }
    if (/(phone|number|טלפון|מספר)/.test(lower) && /\?|\bיכול\b|\bתוכל\b|\bcan you\b/i.test(lower)) {
      return "phone";
    }
    return null; // only check the most recent OUTBOUND turn
  }
  return null;
}

function extractRecentEmail(messages: Array<{ direction: string; body: string | null }>): string | undefined {
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== "INBOUND" || !m.body) continue;
    const match = m.body.match(re);
    if (match) return match[0].toLowerCase();
  }
  return undefined;
}

/**
 * Best-known email/phone for the conversation, used to seed memory facts.
 *
 *   - email: pulled from the customer's transcript (most-recent first).
 *   - phone: WhatsApp conversations carry the phone in `customerExternalId`.
 *
 * The memory module also de-dupes against the linked-identifier CRM record,
 * but having a transcript-anchored fallback means the bot doesn't re-ask
 * for the phone when it's already in the channel metadata.
 */
/**
 * True iff the AI agent has at least one CONNECTED calendar (Google or
 * Calendly). Drives whether `schedule_meeting` is exposed in the tool
 * surface — surfacing it without a backend would let the model promise
 * meeting times it cannot actually book.
 */
async function hasConnectedCalendarFor(tenantId: string, aiAgentId: string): Promise<boolean> {
  try {
    const count = await (prisma as any).calendarAccount.count({
      where: { tenantId, aiAgentId, status: "CONNECTED" },
    });
    return count > 0;
  } catch {
    return false;
  }
}

function pickKnownIdentifier(conv: any, kind: "email" | "phone"): string | undefined {
  if (kind === "phone") {
    const id = conv?.customerExternalId;
    if (!id) return undefined;
    const isPhone = /^\+?\d{6,}$/.test(String(id).replace(/[\s-]/g, ""));
    if (!isPhone) return undefined;
    return String(id).startsWith("+") ? String(id) : `+${id}`;
  }
  return undefined; // email lives in messages, not on the conversation row
}

function renderCustomerInfoBlock(conv: any): string | undefined {
  const lines: string[] = ["## Customer & Conversation Info"];
  if (conv.customerName) lines.push(`- Customer Name: ${conv.customerName}`);
  if (conv.customerExternalId) {
    const isPhone = /^\+?\d{6,}$/.test(String(conv.customerExternalId).replace(/[\s-]/g, ""));
    const label = conv.channel === "WHATSAPP" || isPhone ? "Phone (WhatsApp)" : "External ID";
    const value = conv.channel === "WHATSAPP" && !String(conv.customerExternalId).startsWith("+")
      ? `+${conv.customerExternalId}`
      : conv.customerExternalId;
    lines.push(`- ${label}: ${value}`);
  }
  if (conv.channel) lines.push(`- Channel: ${conv.channel}`);
  if (conv.status) lines.push(`- Conversation Status: ${conv.status}`);
  if (conv.createdAt) lines.push(`- Conversation Started: ${conv.createdAt.toISOString()}`);
  if (conv.lastMessageAt) lines.push(`- Last Message: ${conv.lastMessageAt.toISOString()}`);
  if (lines.length <= 1) return undefined;
  lines.push("");
  lines.push(
    "Use these values when running background actions (CRM lookup, lead create/update, tagging). " +
      "Do NOT ask the customer for information that is already listed here.",
  );
  return lines.join("\n");
}

function renderPendingApprovalsBlock(pending: Array<{ tool: string }>): string | undefined {
  if (!pending.length) return undefined;
  const list = pending.map((a) => `\`${a.tool}\``).join(", ");
  return [
    "## Pending Approval — IMPORTANT",
    `The following tool(s) you proposed earlier are awaiting human approval: ${list}.`,
    "Do NOT call them again in this turn — the request is already in front of the team. " +
      "Keep the conversation moving with the customer in a natural way: answer their question, " +
      "clarify, qualify, or move toward the next step. Do not mention the approval to the customer.",
  ].join("\n");
}

const STRATEGY_TO_LAST_MOVE: Record<string, LastAssistantMove | undefined> = {
  QUALIFY: "qualify",
  GUIDE: "guide",
  CONVERT: "convert",
  RESOLVE: "resolve",
};

/**
 * Look up the BehaviorState from the previous `ai.bot_turn` audit row and
 * map its strategy onto a coarse `LastAssistantMove`. Best-effort.
 */
async function lookupLastAssistantMove(
  tenantId: string,
  conversationId: string,
): Promise<LastAssistantMove | undefined> {
  try {
    const last = await prisma.auditLog.findFirst({
      where: { tenantId, action: "ai.bot_turn", targetId: conversationId },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    const strat = (last?.metadata as any)?.behaviorState?.strategy;
    if (typeof strat === "string") return STRATEGY_TO_LAST_MOVE[strat];
  } catch { /* best-effort */ }
  return undefined;
}

export async function generateAIBotReply(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  incomingMessage: string;
}): Promise<AIBotReplyResult> {
  const config = await prisma.aIAgent.findUnique({ where: { id: opts.aiAgentId } });
  if (!config || config.tenantId !== opts.tenantId) {
    throw Object.assign(new Error("AI Agent not found for tenant"), { status: 404 });
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, tenantId: opts.tenantId },
  });
  if (!conversation) {
    throw Object.assign(new Error("Conversation not found"), { status: 404 });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: opts.conversationId, tenantId: opts.tenantId },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  // Pending approval lookup.
  let pendingApprovals: Array<{ id: string; tool: string }> = [];
  try {
    pendingApprovals = await prisma.approvalRequest.findMany({
      where: { tenantId: opts.tenantId, conversationId: opts.conversationId, status: "PENDING" },
      select: { id: true, tool: true },
      orderBy: { createdAt: "desc" },
    });
  } catch (err: any) {
    console.warn("[ai-bot] pending-approval lookup failed:", err?.message);
  }

  // CRM prefetch — outputs:
  //   crmBlock for the prompt + crmHasLead/crmHasCustomer flags into BEL.
  let crmBlock: string | undefined;
  let crmHasLead = false;
  let crmHasCustomer = false;
  try {
    const recentEmail = extractRecentEmail(messages);
    const prefetch = await prefetchCrmContext(opts.tenantId, opts.conversationId, {
      externalId: conversation.customerExternalId,
      email: recentEmail,
    });
    if (prefetch) {
      crmBlock = renderCrmContextBlock(prefetch) || undefined;
      crmHasLead = prefetch.leadMatches.length > 0;
      crmHasCustomer = prefetch.contactMatches.some((c: any) => {
        const tags: string[] = (c?.tags || c?.lifecycle_stage_tags || []) as string[];
        return Array.isArray(tags) && tags.some((t) => /customer|active|paying/i.test(String(t)));
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] CRM prefetch failed (non-fatal):", err?.message);
  }

  // Identity lookups.
  const contactRow = await prisma.contact.findFirst({
    where: { tenantId: opts.tenantId, channel: conversation.channel, externalId: conversation.customerExternalId },
    select: { id: true },
  });
  const priorConversationCount = await prisma.conversation.count({
    where: {
      tenantId: opts.tenantId,
      channel: conversation.channel,
      customerExternalId: conversation.customerExternalId,
      id: { not: conversation.id },
    },
  });
  const contactLifecycle: "lead" | "customer" | null = crmHasCustomer
    ? "customer"
    : crmHasLead
    ? "lead"
    : null;

  // Last bot turn (for cross-turn coherence).
  const lastAssistantMove = await lookupLastAssistantMove(opts.tenantId, opts.conversationId);

  // Tenant funnel (optional — Task 2). Pre-loaded so BEL stays pure.
  // departmentId is resolved from the conversation's assigned department when
  // available; falls back to null (tenant default funnel).
  const funnelDepartmentId = conversation.departmentId ?? null;
  const funnel = await loadFunnelForTenant({ tenantId: opts.tenantId, departmentId: funnelDepartmentId });

  // Tenant Action Contracts + per-conversation progress. Both loaded
  // up-front so the BEL stays pure. Contracts cache for 60s; progress
  // is per-(conversation, contract) and small.
  const actionContracts = await loadActionContracts(opts.tenantId);
  const actionContractProgress = await loadContractProgress({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    contractIds: actionContracts.map((c) => c.id),
  });

  // ── Behavior Engine — single decision point ─────────────
  const behaviorState = computeBehaviorState({
    mode: "agent",
    identity: {
      hasContact: !!contactRow?.id,
      contactLifecycle,
      priorConversationCount,
      crmRecord: { hasLead: crmHasLead, hasContact: crmHasCustomer },
    },
    request: {
      lastMessage: opts.incomingMessage,
      messageCount: messages.length,
      recentDirections: messages.slice(-5).map((m) => m.direction as "INBOUND" | "OUTBOUND"),
      lastAssistantMove,
      identifierMessage: extractIdentifierFromMessage(opts.incomingMessage),
      assistantPreviouslyAskedFor: detectAssistantAskedFor(messages.map((m) => ({ direction: m.direction, body: m.body }))),
    },
    flags: {
      pendingApprovalsCount: pendingApprovals.length,
      humanHandoffRequested: detectHumanHandoff(opts.incomingMessage),
    },
    funnel,
    actionContracts,
    actionContractProgress,
  });

  // ── KB retrieval — strategy-controlled, NOT regex ──────
  let kbBlock: string | undefined;
  if (shouldRetrieveKB(behaviorState, opts.incomingMessage)) {
    try {
      const chunks = await retrieveRelevantChunks(opts.tenantId, opts.incomingMessage, 5);
      kbBlock = buildKnowledgeContext(chunks) || undefined;
    } catch (err: any) {
      console.warn("[ai-bot] Knowledge retrieval failed:", err.message);
    }
  }

  // ── Conversation memory (Task 5) — fact snapshot injected as ground truth ─
  const memory = buildConversationMemory({
    messages: messages.map((m) => ({
      direction: m.direction as "INBOUND" | "OUTBOUND",
      body: m.body,
      // Future: enrich with intent/outcome from ai.bot_turn audit log.
    })),
    knownEmail: extractRecentEmail(messages.map((m) => ({ direction: m.direction, body: m.body }))),
    knownPhone: pickKnownIdentifier(conversation, "phone"),
  });
  const memoryBlock = renderMemoryBlock(memory);

  // ── Build system prompt ────────────────────────────────
  const ctxSlot: ContextSlot = {
    customerBlock: renderCustomerInfoBlock(conversation),
    crmBlock,
    memoryBlock,
    pendingApprovalsBlock: renderPendingApprovalsBlock(pendingApprovals),
  };

  // ── Tool surface — single source of truth: state.allowedActions ──
  // Build it BEFORE the prompt so we can pass the actual function names
  // into the Execution Contract's capability whitelist.
  const hasConnectedCalendar = await hasConnectedCalendarFor(opts.tenantId, config.id);
  const agentToolCtx: AgentToolContext = {
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    contactId: contactRow?.id,
    authToken: process.env.INTERNAL_SERVICE_TOKEN,
    scheduleMeeting: hasConnectedCalendar
      ? makeScheduleMeetingHandler({ tenantId: opts.tenantId, aiAgentId: config.id })
      : undefined,
    runCustomApiTool: ({ slug, args }) =>
      executeCustomApiTool({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        slug,
        args,
      }),
    runCustomDbTool: async ({ slug, args }: { slug: string; args: Record<string, unknown> }) => {
      const { executeCustomDbQueryTool } = await import("./connectors/custom-db.service");
      return await executeCustomDbQueryTool({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        slug,
        args,
      });
    },
    runAdapterTool: async ({ toolFunctionName, args }) => {
      const result = await executeAdapterTool({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        contactId: contactRow?.id,
        toolFunctionName,
        args,
      });
      // Fire-and-forget notification emit on success only. The classify
      // helper maps refund/discount/meeting tool names to SystemEvents;
      // anything else returns null and skips. Wrapped in tryEmit() so a
      // notification path failure can never throw into the bot turn.
      try {
        if (result.ok) {
          const evt = classifyToolForNotification(toolFunctionName);
          if (evt) {
            tryEmit({
              type: evt,
              tenantId: opts.tenantId,
              data: { tool: toolFunctionName, args, result: result.result },
              metadata: {
                conversationId: opts.conversationId,
                agentId: config.id,
              },
            });
          }
        }
      } catch (err: any) {
        console.warn("[ai-bot] notification emit failed:", err?.message);
      }
      return result;
    },
  };

  let tools = await buildAgentToolsForAIAgent(opts.tenantId, config.id, {
    identityLinking: !!contactRow?.id,
    escalation: true,
    scheduleMeeting: hasConnectedCalendar,
  });

  // ── Custom API tools ── (tenant-defined HTTP calls as bot tools)
  try {
    const customTools = await listCustomApiTools(opts.tenantId);
    for (const t of customTools) {
      tools.push({
        type: "function",
        function: {
          name: `custom.${t.slug}`,
          description:
            `${t.description}\n\nWHEN TO USE: ${t.whenToUse}` +
            (t.whenNotToUse ? `\n\nDO NOT USE: ${t.whenNotToUse}` : ""),
          parameters: t.parameters,
        },
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] custom-api tool surface failed:", err?.message);
  }

  // ── Custom DB query tools ── (tenant-defined SQL/Mongo as bot tools)
  try {
    const { listCustomDbQueryTools } = await import("./connectors/custom-db.service");
    const customDbTools = await listCustomDbQueryTools(opts.tenantId);
    for (const t of customDbTools) {
      tools.push({
        type: "function",
        function: {
          name: `custom_db.${t.slug}`,
          description:
            `${t.description}\n\nWHEN TO USE: ${t.whenToUse}` +
            (t.whenNotToUse ? `\n\nDO NOT USE: ${t.whenNotToUse}` : ""),
          parameters: t.parameters,
        },
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] custom-db tool surface failed:", err?.message);
  }

  // ── Adapter framework tools ── (only for tenants with the integration CONNECTED)
  try {
    const connectedSlugs = new Set<string>();
    const configBySlug = new Map<string, any>();
    const tiRows: any[] = await prisma.tenantIntegration.findMany({
      where: { tenantId: opts.tenantId, status: "CONNECTED" },
      include: { integration: true },
    });
    for (const ti of tiRows) {
      const s = ti.integration?.slug;
      if (!s) continue;
      connectedSlugs.add(s);
      configBySlug.set(s, ti.config || {});
    }
    // Slugs whose adapter tools accept a `table`/`collection` arg and benefit
    // from a tenant-curated table list with per-table notes appended to the
    // tool description (so the AI knows what each table is and when to use it).
    const DB_SLUGS = new Set(["postgres", "mongodb", "aws_rds"]);
    const ADAPTER_TO_CATALOG: Record<string, string> = {
      postgres: "postgresql",
      mongodb: "mongodb",
      aws_rds: "aws_rds",
    };
    for (const adapter of listAdapters()) {
      const catalogSlug = ADAPTER_TO_CATALOG[adapter.slug] || adapter.slug;
      if (!connectedSlugs.has(catalogSlug)) continue;
      const cfg = configBySlug.get(catalogSlug) || {};
      const reads: string[] = Array.isArray(cfg.allowReads) ? cfg.allowReads : [];
      const writes: string[] = Array.isArray(cfg.allowWrites) ? cfg.allowWrites : [];
      const enabled = Array.from(new Set([...reads, ...writes]));
      const tableNotes: Record<string, { description?: string; whenToUse?: string }> =
        (cfg.tableNotes && typeof cfg.tableNotes === "object") ? cfg.tableNotes : {};
      const tablesBlock =
        DB_SLUGS.has(adapter.slug) && enabled.length > 0
          ? "\n\nTABLES AVAILABLE:\n" +
            enabled.map((q) => {
              const n = tableNotes[q] || {};
              const parts: string[] = [`- ${q}`];
              if (reads.includes(q) && writes.includes(q)) parts.push("(read+write)");
              else if (writes.includes(q)) parts.push("(write)");
              else parts.push("(read-only)");
              if (n.description) parts.push(`— ${n.description}`);
              if (n.whenToUse) parts.push(`[USE WHEN: ${n.whenToUse}]`);
              return parts.join(" ");
            }).join("\n")
          : "";
      for (const def of adapter.tools()) {
        tools.push({
          type: "function",
          function: {
            name: def.name,
            description:
              `${def.description}\n\nWHEN TO USE: ${def.whenToUse}` +
              (def.whenNotToUse ? `\n\nDO NOT USE: ${def.whenNotToUse}` : "") +
              (def.sideEffects ? `\n\nSIDE EFFECTS: ${def.sideEffects}` : "") +
              (def.idempotencyNotes ? `\n\nIDEMPOTENCY: ${def.idempotencyNotes}` : "") +
              tablesBlock,
            parameters: def.parameters,
          },
        });
      }
    }
  } catch (err: any) {
    console.warn("[ai-bot] adapter tool surface failed:", err?.message);
  }

  // SINGLE filter — replaces the legacy stripCreateLead/Contact + pendingApprovals filters.
  tools = filterToolsByAllowedActions(tools, behaviorState);

  const toolFunctionNames: string[] = (tools as any[])
    .map((t) => t?.function?.name)
    .filter((n): n is string => typeof n === "string");

  const systemPrompt = buildAgentPrompt({
    behaviorState,
    agent: toAgentRecord(config),
    context: ctxSlot,
    knowledge: { block: kbBlock },
    toolFunctionNames,
  });

  const chatMessages: any[] = [{ role: "system", content: systemPrompt }];
  // Output-contract instruction as the first user message — keeps the model
  // anchored to the per-turn shape requested by BEL.
  const ocInstruction = renderOutputContractInstruction(behaviorState.outputContract);
  if (ocInstruction.trim()) chatMessages.push({ role: "user", content: ocInstruction });

  for (const m of messages) {
    if (!m.body?.trim()) continue;
    if ((m as any).messageType === "system") continue;
    chatMessages.push({
      role: m.direction === "INBOUND" ? "user" : "assistant",
      content: m.body,
    });
  }

  const model = config.model || "gpt-4o-mini";
  let pendingEscalation: AIBotReplyResult["escalation"] = null;
  let awaitingApproval: AIBotReplyResult["awaitingApproval"] = null;
  let replyText: string | null = null;
  let totalTokens = 0;
  const toolCallLog: AIBotReplyResult["toolCallLog"] = [];

  for (let round = 0; round < 3; round++) {
    const response = await generateResponse({
      tenantId: opts.tenantId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      tools: tools as any[],
      metadata: { type: "ai_bot", conversationId: opts.conversationId, aiAgentId: config.id },
    });

    totalTokens += response.usage.total_tokens || 0;

    const toolCalls = response.toolCalls;
    if (toolCalls && toolCalls.length > 0) {
      chatMessages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: toolCalls,
      });

      let pausedForApproval: AIBotReplyResult["awaitingApproval"] = null;
      for (const tc of toolCalls) {
        const toolName = tc.function?.name || "unknown";
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

        const exec = await getActionOrchestrator().submit(
          {
            id: randomUUID(),
            conversationId: agentToolCtx.conversationId ?? "",
            tenantId: agentToolCtx.tenantId,
            proposedBy: { mode: "chat", system: "ai-bot" },
            actor: { agentId: "" },
            tool: toolName,
            args: toolArgs,
            rationale: "ai-bot inbox tool call",
            urgency: "low",
          },
          () =>
            dispatchToolCall(
              { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
              agentToolCtx,
            ),
        );
        const result = unwrapToolExec(tc.id, toolName, exec);

        const sideEffectType = result.sideEffect?.awaitingApproval ? "awaiting_approval"
          : result.sideEffect?.denied ? "denied"
          : result.sideEffect?.escalate ? "escalate"
          : undefined;
        toolCallLog.push({
          tool: toolName,
          args: toolArgs,
          result: result.content,
          decision: sideEffectType || "executed",
          sideEffect: sideEffectType,
        });

        prisma.auditLog.create({
          data: {
            tenantId: opts.tenantId,
            actorType: "ai",
            action: `ai.tool_call.${toolName}`,
            targetType: "conversation",
            targetId: opts.conversationId,
            metadata: {
              tool: toolName,
              args: toolArgs,
              decision: sideEffectType || "executed",
              result: result.content.slice(0, 500),
              source: "ai_bot",
            },
          },
        }).catch((err: any) => console.error(`[ai-bot] Tool call audit failed for ${toolName}:`, err.message));

        if (result.sideEffect?.escalate) pendingEscalation = result.sideEffect.escalate;
        if (result.sideEffect?.awaitingApproval && !pausedForApproval) {
          pausedForApproval = result.sideEffect.awaitingApproval;
        }

        // Action Contract progress — record this tool execution against
        // any active contract that lists it. Idempotent: a re-dispatch
        // never double-counts. SEQUENCE contracts pause if the result
        // came back as awaiting_approval (no further steps until cleared).
        try {
          const matchingContracts = behaviorState.actionContractState.contracts
            .filter((c) => c.pending.includes(toolName))
            .map((c) => actionContracts.find((x) => x.id === c.id))
            .filter((c): c is ActionContract => !!c);

          for (const contract of matchingContracts) {
            if (sideEffectType === "awaiting_approval") {
              await markContractPaused({
                conversationId: opts.conversationId,
                contractId: contract.id,
                reason: "tool_awaiting_approval",
              });
              console.log(`[ai-bot] contract.paused trigger=${contract.trigger} tool=${toolName}`);
              continue;
            }
            if (sideEffectType === "denied") {
              continue; // tool was rejected; don't credit progress
            }
            await markContractToolCompleted({
              tenantId: opts.tenantId,
              conversationId: opts.conversationId,
              contract,
              toolName,
            });
            console.log(`[ai-bot] contract.tool_done trigger=${contract.trigger} tool=${toolName}`);
          }
        } catch (err: any) {
          console.warn("[ai-bot] contract progress write failed:", err?.message);
        }

        chatMessages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: result.content,
        });
      }

      if (pausedForApproval) {
        awaitingApproval = pausedForApproval;
        break;
      }
      continue;
    }

    replyText = response.content?.trim() || null;
    break;
  }

  // ── Runtime contract enforcement ────────────────────────────────
  // If a required action had a matching tool in the surface but the LLM
  // never called it, push a final "VIOLATION" reminder and re-loop ONCE.
  // No customer-facing reply goes out until either the contract is
  // satisfied or we've burned our retry. After the retry, we accept
  // whatever the model returns and log the violation for later analysis.
  const unmetRequired = computeUnmetRequiredActions(behaviorState.requiredActions, toolFunctionNames, toolCallLog);

  // ── Action Contract violations (tool-name level) ──────────────
  // After the dispatch loop, recompute pending tools per contract using
  // the actual completed list. Any blocking, non-paused contract with
  // pending tools → force a retry that names the missing tools verbatim.
  const completedToolNamesThisTurn = new Set<string>(
    toolCallLog.filter((c) => c.decision === "executed").map((c) => c.tool),
  );
  const contractViolations: Array<{ trigger: string; missing: string[]; mode: string }> = [];
  for (const summary of behaviorState.actionContractState.contracts) {
    if (!summary.blocking) continue;
    if (summary.completed.length + completedToolNamesThisTurn.size === 0) continue;
    // Derive what's still pending after this turn's executions.
    const stillPending = summary.requiredTools.filter((name) => {
      if (summary.completed.includes(name)) return false;
      if (completedToolNamesThisTurn.has(name)) return false;
      return true;
    });
    if (summary.executionMode === "AT_LEAST_ONE") {
      const anyDone = summary.requiredTools.some(
        (n) => summary.completed.includes(n) || completedToolNamesThisTurn.has(n),
      );
      if (anyDone) continue;
    }
    if (stillPending.length > 0) {
      contractViolations.push({ trigger: summary.trigger, missing: stillPending, mode: summary.executionMode });
    }
  }

  if ((unmetRequired.length > 0 || contractViolations.length > 0) && !awaitingApproval && !pendingEscalation) {
    const reasonParts: string[] = [];
    if (unmetRequired.length) {
      reasonParts.push(
        `Missing required tools: ${unmetRequired.map((u) => `\`${u.toolName}\` (for \`${u.action}\`)`).join(", ")}.`,
      );
    }
    if (contractViolations.length) {
      reasonParts.push(
        contractViolations
          .map((v) => `Action Contract \`${v.trigger}\` (${v.mode}) requires: ${v.missing.map((m) => `\`${m}\``).join(", ")}.`)
          .join(" "),
      );
    }
    console.warn(`[ai-bot] Contract violation — ${reasonParts.join(" | ")}. Forcing retry.`);
    chatMessages.push({
      role: "user",
      content:
        `**CONTRACT VIOLATION DETECTED.** ${reasonParts.join(" ")} ` +
        `You MUST call the missing tool(s) NOW before producing any reply text. ` +
        `This is the regeneration the original prompt warned about. Do not skip again.`,
    });

    const retryResponse = await generateResponse({
      tenantId: opts.tenantId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      tools: tools as any[],
      metadata: { type: "ai_bot_retry", conversationId: opts.conversationId, aiAgentId: config.id },
    });
    totalTokens += retryResponse.usage.total_tokens || 0;

    const retryToolCalls = retryResponse.toolCalls;
    if (retryToolCalls && retryToolCalls.length > 0) {
      chatMessages.push({
        role: "assistant",
        content: retryResponse.content || "",
        tool_calls: retryToolCalls,
      });
      for (const tc of retryToolCalls) {
        const toolName = tc.function?.name || "unknown";
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        const exec = await getActionOrchestrator().submit(
          {
            id: randomUUID(),
            conversationId: agentToolCtx.conversationId ?? "",
            tenantId: agentToolCtx.tenantId,
            proposedBy: { mode: "chat", system: "ai-bot:retry" },
            actor: { agentId: "" },
            tool: toolName,
            args: toolArgs,
            rationale: "ai-bot retry-loop tool call",
            urgency: "low",
          },
          () =>
            dispatchToolCall(
              { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
              agentToolCtx,
            ),
        );
        const result = unwrapToolExec(tc.id, toolName, exec);
        toolCallLog.push({
          tool: toolName,
          args: toolArgs,
          result: result.content,
          decision: "executed_on_retry",
          sideEffect: undefined,
        });

        // Same contract-progress tracking as the main loop.
        try {
          const matchingContracts = behaviorState.actionContractState.contracts
            .map((c) => actionContracts.find((x) => x.id === c.id))
            .filter((c): c is ActionContract => !!c)
            .filter((c) => c.requiredTools.some((t) => t.name === toolName));
          for (const contract of matchingContracts) {
            await markContractToolCompleted({
              tenantId: opts.tenantId,
              conversationId: opts.conversationId,
              contract,
              toolName,
            });
          }
        } catch {/* non-fatal */}

        chatMessages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: result.content,
        });
      }
      // Final pass to get the customer-facing reply text.
      const finalResp = await generateResponse({
        tenantId: opts.tenantId,
        model,
        messages: chatMessages,
        temperature: config.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? 1024,
        tools: tools as any[],
        metadata: { type: "ai_bot_retry_final", conversationId: opts.conversationId, aiAgentId: config.id },
      });
      totalTokens += finalResp.usage.total_tokens || 0;
      if (finalResp.content?.trim()) replyText = finalResp.content.trim();
    } else {
      // Model still didn't call. Use whatever text it returned and log the persistent violation.
      console.warn(`[ai-bot] Contract violation persists after retry. Accepting reply anyway.`);
      if (retryResponse.content?.trim()) replyText = retryResponse.content.trim();
    }
  }

  // Audit — full BehaviorState + tool calls.
  prisma.auditLog.create({
    data: {
      tenantId: opts.tenantId,
      actorType: "ai",
      action: "ai.bot_turn",
      targetType: "conversation",
      targetId: opts.conversationId,
      metadata: {
        model,
        tokens: totalTokens,
        source: "ai_bot",
        escalated: !!pendingEscalation,
        awaitingApproval: !!awaitingApproval,
        toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
        behaviorState: {
          strategy: behaviorState.strategy,
          userType: behaviorState.userType,
          conversationStage: behaviorState.conversationStage,
          intent: behaviorState.intent,
          urgency: behaviorState.urgency,
          autonomy: behaviorState.autonomy,
          toneIntensity: behaviorState.toneIntensity,
          escalationPressure: behaviorState.escalationPressure,
          confidence: behaviorState.confidence,
          outputContract: behaviorState.outputContract,
          decisionIntent: behaviorState.decisionIntent,
          allowedActions: behaviorState.allowedActions,
          requiredActions: behaviorState.requiredActions,
          playbookIds: behaviorState.playbookIds,
          provenance: behaviorState.provenance,
        },
      },
    },
  }).catch((err: any) => console.error("[ai-bot] Audit log failed:", err.message));

  // Notification emit: conversation escalated. Fire when BEL signals
  // escalate_now or when a tool side-effect set pendingEscalation. Wrapped
  // in tryEmit + try/catch — never throws into the hot path.
  try {
    if (behaviorState.escalationPressure === "escalate_now" || pendingEscalation) {
      tryEmit({
        type: "conversation.escalated",
        tenantId: opts.tenantId,
        data: {
          reason: pendingEscalation?.reason ?? "escalation_pressure=escalate_now",
          priority: pendingEscalation?.priority,
          summary: pendingEscalation?.summary,
        },
        metadata: {
          conversationId: opts.conversationId,
          agentId: config.id,
        },
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] escalation emit failed:", err?.message);
  }

  return {
    reply: awaitingApproval ? null : replyText,
    escalation: pendingEscalation,
    awaitingApproval,
    toolCallLog,
    modelUsed: model,
    totalTokens,
  };
}

// ─── One-shot reply (no conversation, no tools) ─────────────

export async function generateAIBotOneshot(opts: {
  tenantId: string;
  aiAgentId: string;
  userInput: string;
  maxTokens?: number;
  feature?: string;
}): Promise<{ reply: string | null; modelUsed: string; totalTokens: number }> {
  const config = await prisma.aIAgent.findUnique({ where: { id: opts.aiAgentId } });
  if (!config || config.tenantId !== opts.tenantId) {
    throw Object.assign(new Error("AI Agent not found for tenant"), { status: 404 });
  }
  if (config.status === "PAUSED") {
    return { reply: null, modelUsed: config.model || "gpt-4o-mini", totalTokens: 0 };
  }

  const oneshotState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: opts.userInput, messageCount: 1 },
  });

  const systemPrompt = buildAgentPrompt({
    behaviorState: oneshotState,
    agent: toAgentRecord(config),
  });

  const model = config.model || "gpt-4o-mini";
  const maxTokens = opts.maxTokens ?? Math.min(config.maxTokens ?? 1024, 400);

  const result = await generateResponse({
    tenantId: opts.tenantId,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: opts.userInput },
    ],
    temperature: config.temperature ?? 0.7,
    maxTokens,
    metadata: { type: opts.feature || "comment_reply", aiAgentId: config.id },
  });

  return {
    reply: result.content?.trim() || null,
    modelUsed: model,
    totalTokens: result.usage.total_tokens || 0,
  };
}
