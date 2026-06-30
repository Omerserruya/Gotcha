/**
 * OpenAI Provider - refactored to use central aiService for ALL LLM calls.
 * Reads BehaviorState for output contract + KB gating + tool surface.
 */

import type { AIProvider, ConversationContext, AISuggestion, IntentClassification, AgentChatParams, CopilotConfigData } from "./ai-assist.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";
import { generateResponse, getDefaultModel } from "./ai.service";
import { isAbortError } from "./turn-cancellation.service";
import { prisma, dispatchToolCall, publishEvent } from "@chatcenter/shared";
import type { AgentToolContext } from "@chatcenter/shared";
import {
  buildAgentPrompt,
  computeCurrentPlanForOpts,
  renderOutputContractInstruction,
  type AgentRecord,
  type BuildPromptOpts,
  type ContextSlot,
} from "./prompt-builder.service";
import {
  computeBehaviorState,
  shouldRetrieveKB,
  type BehaviorState,
} from "./behavior-engine.service";
import { prefetchCrmContext, renderCrmContextBlock } from "./crm-prefetch.service";
import { assemblePlanContext, type AssembledPlanContext } from "./plan-context.service";
import { routeCopilotTool } from "./capabilities";
import { assembleCopilotToolSurface } from "./copilot-tool-surface.service";
// CALENDAR capability execution — the ONE runtime pipeline, advisory mode. The
// Copilot no longer has its own calendar execution logic.
import { executeCalendarToolAdvisory, isCalendarTool } from "./capability-runtime/calendar.execute";
import { preResolveCalendarRead } from "./capability-runtime/calendar.preresolve";
import { createProdCalendarPort } from "./capability-runtime/calendar.port.prod";
import { isCalendarRuntimeEnabled } from "./capability-runtime/flags";

const copilotCalPort = createProdCalendarPort();
import {
  logCopilotPlan,
  logCopilotTool,
  plannerReasonForTool,
  noToolDecision,
  summarizeToolResult,
  type CopilotDiagContext,
} from "./copilot-diagnostics.service";
import type { CrmStateFlags } from "./prospect-state";

// Terminator tool - copilot uses this to "finish" with structured output.
//
// `signals` is OPTIONAL and DELIBERATELY NOISE-INTOLERANT. The default outcome
// for any inbound is **no signal**. Only emit a signal when the customer's
// LATEST inbound message contains a clear, quotable phrase that proves the
// signal - never on tone alone, never on the bot's interpretation, never on
// trivial messages (one-word replies, emoji-only, < 5 words).
const SIGNAL_KINDS = [
  "buy_intent",        // Strong purchase intent: "I want to buy", "let's go ahead", "send me the contract"
  "strong_objection",  // Hard pushback: "this is not for us", "not interested"
  "price_objection",   // Cost-specific concern: "too expensive", "out of budget"
  "hesitation",        // Visible doubt with reason cited: "I'm not sure because…"
  "rejection",         // Customer is closing the door: "stop messaging me", "no thanks"
  "urgency",           // Time pressure: "I need this by Friday", "ASAP"
  "confusion",         // Customer can't follow: "what do you mean?", "I don't understand"
  "churn_risk",        // Existing-customer dissatisfaction: "I'm cancelling", "this is the last straw"
] as const;

const SUBMIT_SUGGESTIONS_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_suggestions",
    description:
      "Call this to FINISH and return your final suggestions to the human agent. " +
      "Call it exactly once, after you've used any read-only tools you need. " +
      "Your suggestions MUST come from the Current Plan: each is a different way to take the plan's " +
      "best next action toward the current goal. Offer DISTINCT variants — typically (1) the best " +
      "recommendation, (2) a softer approach, (3) a more direct approach — not three rephrasings of one line. " +
      "If you auto-ran read-only tools, WEAVE the retrieved facts into the replies (e.g. 'the calendar is open " +
      "tomorrow at 11:00 and 14:00', 'the last order was 8 days ago') so the human doesn't have to look them up. " +
      "If the plan's best move is a customer-facing ACTION (book / create / refund / send), do NOT perform it — " +
      "recommend it to the human (an `action`-type suggestion) describing the action and why it advances the goal. " +
      "If no tool is needed, say so plainly in your reply suggestions. " +
      "OPTIONAL: include `signals` ONLY when the customer's latest message contains a clearly " +
      "quotable phrase proving the signal. Default is empty. Never invent signals from tone.",
    parameters: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          description: "2–3 plan-aligned suggestions, each a distinct approach to the goal",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              confidence: { type: "number" },
              type: { type: "string", enum: ["reply", "action", "info"] },
              approach: {
                type: "string",
                enum: ["best", "softer", "direct"],
                description: "Which variant this is — keep the three distinct.",
              },
              rationale: {
                type: "string",
                description: "One short clause: why this move advances the current goal.",
              },
            },
            required: ["text", "confidence", "type"],
          },
        },
        signals: {
          type: "array",
          description:
            "Up to 2 distinct signals from the LATEST customer inbound message. " +
            "Each MUST quote the exact substring proving it (`evidence`). " +
            "Set confidence ≥ 0.85 or omit. Empty array (or omitted) is the correct default.",
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...SIGNAL_KINDS] },
              severity: { type: "string", enum: ["soft", "strong"] },
              evidence: {
                type: "string",
                description:
                  "Exact verbatim substring (1–80 chars) from the customer's latest inbound message.",
              },
              confidence: { type: "number", description: "0–1 (only ≥ 0.85 will be persisted)" },
            },
            required: ["kind", "severity", "evidence", "confidence"],
          },
        },
      },
      required: ["suggestions"],
    },
  },
};

interface MessageSignal {
  kind: typeof SIGNAL_KINDS[number];
  severity: "soft" | "strong";
  evidence: string;
  confidence: number;
}

/**
 * Validate, dedupe and persist signals on the latest inbound message of a conversation.
 *
 * Filters applied (defense in depth - the prompt already says these things, but
 * the model has been known to ignore prompts):
 *   - confidence < 0.85         → drop
 *   - evidence not actually present in the message body → drop
 *   - duplicate kind already on this conversation       → drop
 *   - inbound body shorter than 5 words                 → all signals dropped
 *   - more than 2 signals                               → keep top 2 by confidence
 *
 * Emits `message:updated` (which the conversation-service relays to the
 * tenant socket room) so the chat panel renders chips without a refetch.
 */
async function persistMessageSignals(
  tenantId: string,
  conversationId: string,
  rawSignals: unknown,
): Promise<void> {
  if (!Array.isArray(rawSignals) || rawSignals.length === 0) return;
  if (!tenantId || !conversationId) return;

  // Find the latest INBOUND text message in the conversation. That's the one
  // the copilot just analysed.
  const latestInbound = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "INBOUND", messageType: { not: "system" as any } },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true, metadata: true },
  });
  if (!latestInbound?.id || !latestInbound.body) return;

  const wordCount = latestInbound.body.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) return;

  const bodyLower = latestInbound.body.toLowerCase();

  const validKinds = new Set<string>(SIGNAL_KINDS as readonly string[]);
  const seenKinds = new Set<string>();
  const cleaned: MessageSignal[] = [];

  // Collect kinds already present on EARLIER inbounds in this conversation -
  // we don't re-flag the same signal across turns.
  const earlierMessages = await prisma.message.findMany({
    where: { tenantId, conversationId, direction: "INBOUND", id: { not: latestInbound.id } },
    select: { metadata: true },
  });
  for (const m of earlierMessages) {
    const sigs = ((m.metadata as any)?.signals ?? []) as Array<{ kind?: string }>;
    for (const s of sigs) if (s?.kind) seenKinds.add(s.kind);
  }

  for (const raw of rawSignals as Array<Partial<MessageSignal>>) {
    if (!raw || typeof raw !== "object") continue;
    const { kind, severity, evidence } = raw;
    const confidence = Number(raw.confidence);
    if (!kind || !validKinds.has(kind)) continue;
    if (severity !== "soft" && severity !== "strong") continue;
    if (!evidence || typeof evidence !== "string" || evidence.length < 1 || evidence.length > 80) continue;
    if (!Number.isFinite(confidence) || confidence < 0.85) continue;
    if (!bodyLower.includes(evidence.toLowerCase())) continue;
    if (seenKinds.has(kind)) continue;
    seenKinds.add(kind);
    cleaned.push({ kind: kind as MessageSignal["kind"], severity, evidence, confidence });
  }

  if (cleaned.length === 0) return;
  cleaned.sort((a, b) => b.confidence - a.confidence);
  const finalSignals = cleaned.slice(0, 2);

  const mergedMetadata = {
    ...((latestInbound.metadata as any) ?? {}),
    signals: finalSignals,
  };

  await prisma.message.update({
    where: { id: latestInbound.id },
    data: { metadata: mergedMetadata as any },
  });

  publishEvent({
    event: "message:updated",
    tenantId,
    data: {
      conversationId,
      messageId: latestInbound.id,
      patch: { metadata: mergedMetadata },
    },
  }).catch(() => { /* fire-and-forget */ });
}

// Minimal stub agent used when no copilotConfig is present (tests / dev).
// `description` field dropped per spec - identity flows through role +
// persona + identity block, never free-text on the agent record.
const STUB_COPILOT_AGENT: AgentRecord = {
  name: "AI Copilot",
  role: "customer_support",
  tone: "professional",
};

function renderCustomerInfoBlock(context: ConversationContext): string | undefined {
  const meta = context.conversationMeta;
  const mem = context.customerMemory;
  if (!meta && !context.customerName && !mem) return undefined;
  const lines: string[] = ["## Customer & Conversation Info"];
  lines.push(`- Customer: ${context.customerName || "Unknown"}`);
  if (meta?.customerExternalId) lines.push(`- External ID / Phone: ${meta.customerExternalId}`);
  if (meta?.channel) lines.push(`- Channel: ${meta.channel}`);
  if (meta?.status) lines.push(`- Conversation Status: ${meta.status}`);
  if (meta?.departmentName) lines.push(`- Department: ${meta.departmentName}`);
  if (meta?.assignedAgentName) lines.push(`- Assigned Agent: ${meta.assignedAgentName}`);
  if (meta?.createdAt) lines.push(`- Conversation Started: ${meta.createdAt}`);
  if (meta?.lastMessageAt) lines.push(`- Last Message: ${meta.lastMessageAt}`);
  if (meta?.isHandedOver !== undefined) lines.push(`- Handed Over to Human: ${meta.isHandedOver ? "Yes" : "No"}`);

  // ─── Customer memory (cross-channel) ───
  // Loaded by customer-context.service.loadCustomerContext. Tells the AI
  // about outstanding promises, prior interactions, and trend so it doesn't
  // restart relationships or repeat commitments.
  if (mem) {
    if (mem.openIssues && mem.openIssues.length) {
      lines.push("", "## Open Issues (CRM tasks - outstanding commitments)");
      for (const i of mem.openIssues.slice(0, 5)) {
        const parts: string[] = [];
        if (i.priority) parts.push(`[${i.priority}]`);
        if (i.status) parts.push(`(${i.status})`);
        parts.push(i.subject);
        if (i.due_at) parts.push(`- due ${i.due_at}`);
        lines.push(`- ${parts.join(" ")}`);
      }
    }
    if (mem.recentSummaries && mem.recentSummaries.length) {
      lines.push("", "## Recent prior interactions (cross-channel)");
      for (const s of mem.recentSummaries.slice(0, 3)) {
        const head: string[] = [`[${s.channel}` + (s.occurredAt ? ` ${s.occurredAt.slice(0, 10)}]` : "]")];
        if (s.sentiment) head.push(`sentiment: ${s.sentiment}`);
        if (s.qualification) head.push(`qualification: ${s.qualification}`);
        lines.push(`- ${head.join(" - ")}`);
        if (s.summary) lines.push(`  ${s.summary.slice(0, 280)}`);
      }
    }
    if (mem.sentimentTrend && mem.sentimentTrend.length) {
      lines.push(`- Sentiment trend (most-recent first): ${mem.sentimentTrend.join(", ")}`);
    }
    if (mem.recentCrmNotes && mem.recentCrmNotes.length) {
      lines.push("", "## Recent CRM notes");
      for (const n of mem.recentCrmNotes.slice(0, 3)) {
        lines.push(`- ${n.body.slice(0, 200)}`);
      }
    }
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

function pickAgent(config?: CopilotConfigData | null): AgentRecord {
  return config?.agent || STUB_COPILOT_AGENT;
}

export class OpenAIProvider implements AIProvider {
  private defaultModel: string;

  constructor(_apiKey: string, _baseURL?: string, defaultModel?: string) {
    this.defaultModel = defaultModel || getDefaultModel();
  }

  async suggestResponse(context: ConversationContext): Promise<AISuggestion[]> {
    const config = context.copilotConfig;
    if (config && !config.isActive) {
      return [{ id: "disabled", text: "Co-Pilot is disabled for this tenant.", confidence: 0, type: "info" }];
    }

    // ── BEL - copilot mode forces SUPPORT_AGENT, advisory autonomy.
    const lastInbound = [...context.messages].reverse().find((m) => m.direction === "INBOUND");
    const copilotBehavior = computeBehaviorState({
      mode: "copilot",
      identity: {
        hasContact: !!context.conversationMeta?.customerExternalId,
        contactLifecycle: null,
        priorConversationCount: 0,
      },
      request: {
        lastMessage: lastInbound?.body || "",
        messageCount: context.messages.length,
        recentDirections: context.messages.slice(-5).map((m) => m.direction),
        recentInboundTexts: context.messages
          .filter((m) => m.direction === "INBOUND")
          .slice(-5)
          .map((m) => m.body || ""),
      },
      copilotPreferredMode: config?.copilotMode,
    });

    // ── KB - strategy-controlled, NOT regex.
    let kbBlock: string | undefined;
    if (context.tenantId && lastInbound?.body && shouldRetrieveKB(copilotBehavior, lastInbound.body)) {
      try {
        const chunks = await retrieveRelevantChunks(context.tenantId, lastInbound.body, 5);
        kbBlock = buildKnowledgeContext(chunks) || undefined;
      } catch (err: any) {
        console.warn("[RAG] Knowledge retrieval failed:", err.message);
      }
    }

    const ctxSlot: ContextSlot = {
      customerBlock: renderCustomerInfoBlock(context),
      locale: context.locale,
    };

    const model = config?.model || this.defaultModel;

    let contactId: string | undefined;
    if (context.tenantId && context.conversationMeta?.customerExternalId && context.conversationMeta?.channel) {
      try {
        const contact = await prisma.contact.findFirst({
          where: {
            tenantId: context.tenantId,
            channel: context.conversationMeta.channel as any,
            externalId: context.conversationMeta.customerExternalId,
          },
          select: { id: true },
        });
        contactId = contact?.id;
      } catch { /* best-effort */ }
    }
    const aiAgentId = context.conversationMeta?.aiAgentId;
    const extIdForCal = context.conversationMeta?.customerExternalId;

    // SURFACE PARITY: ONE shared builder resolves calendar capability + active
    // booking and assembles the calendar-gated advisory tool surface — the exact
    // SAME surface the CHAT Copilot path now consumes (no mirrored implementation).
    // Without it the model can't run check_availability (and invents times) nor
    // recommend a real schedule_meeting. READ tools auto-run (handler wired below);
    // the decision-gate keeps ACTIONs recommend-only.
    const surface = await assembleCopilotToolSurface({
      tenantId: context.tenantId || "",
      conversationId: context.conversationId,
      aiAgentId,
      contactId,
      customerExternalId: extIdForCal,
    });
    const calendarBookable = surface.calendarBookable;
    const hasActiveBooking = surface.hasActiveBooking;

    const toolCtx: AgentToolContext = {
      tenantId: context.tenantId || "",
      conversationId: context.conversationId,
      contactId,
      authToken: process.env.INTERNAL_SERVICE_TOKEN,
      mode: "copilot",
      // check_availability is READ → the decision-gate lets it auto-run, so its
      // handler must be wired. schedule/reschedule/cancel are ACTIONs the gate
      // intercepts (recommend-only), so they need surface presence, not a handler.
      checkAvailability: surface.checkAvailabilityHandler,
    };

    // The terminator (submit_suggestions) is the ONLY thing the primary path adds
    // on top of the shared surface; the CHAT path omits it (free text). Everything
    // dispatchable is identical across both Copilot entry points.
    const tools: any[] = [SUBMIT_SUGGESTIONS_TOOL, ...surface.tools];
    const toolFunctionNames: string[] = tools
      .map((t: any) => t?.function?.name)
      .filter((n: any): n is string => typeof n === "string");
    // ── SHARED BRAIN ──────────────────────────────────────────────────────
    // Build the SAME Current Plan the AI Employee reasons over, so the Copilot's
    // recommendation is driven by the identical goal / objective / next-action /
    // capability engine (assemblePlanContext → computeCurrentPlan, via
    // buildAgentPrompt). There is NO copilot-specific reasoning here — only the
    // downstream EXECUTION differs (the Copilot recommends customer-facing actions
    // to the human and auto-runs only safe reads).
    let planCtx: AssembledPlanContext | undefined;
    try {
      let crmFlags: CrmStateFlags = { hasLead: false, hasContact: false };
      const extId = context.conversationMeta?.customerExternalId;
      if (context.tenantId && extId) {
        const prefetch = await prefetchCrmContext(context.tenantId, context.conversationId, { externalId: extId });
        if (prefetch) {
          ctxSlot.crmBlock = renderCrmContextBlock(prefetch) || ctxSlot.crmBlock;
          const hasLead = prefetch.leadMatches.length > 0;
          crmFlags = {
            hasLead,
            hasContact: hasLead || prefetch.contactMatches.length > 0,
            isCustomer: prefetch.contactMatches.length > 0,
          };
        }
      }
      const planAgent = pickAgent(config) as any;
      planCtx = await assemblePlanContext({
        tenantId: context.tenantId || "",
        conversationId: context.conversationId,
        role: planAgent?.role || "agent",
        agentId: aiAgentId ?? planAgent?.id ?? null,
        goal: planAgent?.goal ?? null,
        salesContext: planAgent?.salesContext,
        customer: { channel: context.conversationMeta?.channel || "", externalId: extId },
        crmFlags,
        contextBlocks: { customerBlock: ctxSlot.customerBlock, crmBlock: ctxSlot.crmBlock },
        messages: context.messages,
        signal: context.signal,
      });
    } catch (err: any) {
      console.warn("[copilot] plan context assembly failed (non-fatal):", err?.message);
    }

    const promptOpts: BuildPromptOpts = {
      behaviorState: copilotBehavior,
      agent: pickAgent(config),
      context: ctxSlot,
      knowledge: { block: kbBlock },
      toolFunctionNames,
      toolCapabilityHints: planCtx?.toolCapabilityHints,
      crm: planCtx?.crmFlags,
      completedActionTools: planCtx?.completedActionTools,
      priorGoal: planCtx?.priorGoal,
      wizardFacts: planCtx?.wizardFacts,
      calendarBookable,
      hasActiveBooking,
    };
    const systemPrompt = buildAgentPrompt(promptOpts);
    const chatMessages = this.buildChatMessages(context, systemPrompt, copilotBehavior);

    // ── DIAGNOSTICS ───────────────────────────────────────────────────────
    // The EXACT plan the prompt rendered (same opts → same CurrentPlan), logged
    // before the model reasons. `tools[]` below route through routeCopilotTool so
    // every READ/ACTION/MISSING_INFORMATION decision is observable from stdout.
    const diag: CopilotDiagContext = {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      entry: "suggest",
    };
    const plan = computeCurrentPlanForOpts(promptOpts);
    logCopilotPlan(plan, diag);

    // PLANNER-OWNED EXECUTION (Runtime before LLM, ADVISORY): run the calendar
    // READ now and inject the REAL open times so the Copilot drafts real options,
    // never "I'll check". Same runtime call as the Employee — only the mode differs.
    if (isCalendarRuntimeEnabled(context.tenantId || "") && plan) {
      const pre = await preResolveCalendarRead({
        objective: plan.currentObjective,
        calendarBookable,
        hasActiveBooking,
        mode: "advisory",
        context: { tenantId: context.tenantId || "", conversationId: context.conversationId, customerExternalId: extIdForCal ?? undefined, aiAgentId: aiAgentId ?? undefined },
        port: copilotCalPort,
      });
      if (pre.block) chatMessages.push({ role: "system", content: pre.block } as any);
    }

    let dispatchedToolCount = 0;

    const quickActions: AISuggestion[] = [];
    let finalSuggestions: AISuggestion[] = [];

    try {
      for (let round = 0; round < 4; round++) {
        const result = await generateResponse({
          tenantId: context.tenantId || "",
          // Same conversation → same session so the prefix cache routes
          // suggestion turns consistently to the same backend.
          sessionId: context.conversationId,
          model,
          messages: chatMessages,
          temperature: config?.temperature ?? 0.7,
          maxTokens: config?.maxTokens ?? 1024,
          metadata: { type: "suggestion", conversationId: context.conversationId },
          tools,
          signal: context.signal,
        });

        const toolCalls = result.toolCalls;
        if (!toolCalls || toolCalls.length === 0) {
          if (result.content?.trim()) {
            finalSuggestions = [{ id: "openai-text", text: result.content.trim(), confidence: 0.5, type: "info" }];
          }
          break;
        }

        chatMessages.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: toolCalls,
        } as any);

        let terminated = false;
        for (const tc of toolCalls) {
          const toolName = tc.function?.name || "";
          if (toolName === "submit_suggestions") {
            try {
              const parsed = JSON.parse(tc.function?.arguments || "{}");
              const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
              finalSuggestions = list.map((s: any, i: number) => ({
                id: `openai-${i}`,
                text: typeof s === "string" ? s : (s.text || ""),
                confidence: typeof s === "object" ? (s.confidence ?? 0.8) : 0.8,
                type: (typeof s === "object" ? s.type : "reply") as AISuggestion["type"],
              })).filter((s: AISuggestion) => s.text);

              // Persist intent-signal annotations on the latest inbound message
              // (best-effort; never blocks the suggestion response).
              if (parsed.signals !== undefined && context.tenantId && context.conversationId) {
                persistMessageSignals(context.tenantId, context.conversationId, parsed.signals)
                  .catch((err: any) =>
                    console.warn("[copilot] persistMessageSignals failed:", err?.message),
                  );
              }
            } catch (err: any) {
              console.warn("[copilot] submit_suggestions JSON parse failed:", err.message);
            }
            chatMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: true }),
            } as any);
            terminated = true;
            continue;
          }

          // ── DECISION ENGINE ────────────────────────────────────────────
          // The Copilot is not a tool caller; it decides WHO executes via the
          // shared routeCopilotTool (single source of truth, also used by CHAT).
          // Safe READ tools run automatically to enrich the suggestion. Customer-
          // facing ACTIONS are NEVER executed here — they are surfaced to the
          // human agent as a recommendation with the tool + args attached, and
          // the model is told it was surfaced so it keeps drafting the reply.
          dispatchedToolCount++;

          // CALENDAR → the ONE runtime pipeline (ADVISORY): READ auto-runs and
          // returns real facts; WRITE is recommended (never executed). No
          // copilot-specific calendar logic remains — same pipeline as the
          // employee, differing only in ExecutionMode.
          if (isCalendarTool(toolName)) {
            let calArgs: Record<string, unknown> = {};
            try { calArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { /* {} */ }
            const adv = await executeCalendarToolAdvisory({
              toolName,
              toolArgs: calArgs,
              context: { tenantId: context.tenantId || "", conversationId: context.conversationId, customerExternalId: extIdForCal ?? undefined, aiAgentId: aiAgentId ?? undefined },
              port: copilotCalPort,
              plannerGoal: plan?.goal ?? undefined,
            });
            chatMessages.push({ role: "tool", tool_call_id: tc.id, content: adv.content } as any);
            if (adv.quickAction) {
              quickActions.push({
                id: `quick-${quickActions.length}`,
                text: humanizeQuickAction(adv.quickAction.tool, adv.quickAction.args),
                confidence: 0.9,
                type: "quick_action",
                quickAction: adv.quickAction,
              });
            }
            logCopilotTool({
              decision: adv.quickAction ? "ACTION" : "READ",
              plannerReason: plannerReasonForTool(plan, toolName),
              tool: toolName,
              executed: !adv.quickAction,
              executionMode: adv.quickAction ? "recommended" : "background",
              result: summarizeToolResult(adv.content),
            }, diag);
            continue;
          }

          const routing = routeCopilotTool(toolName);
          if (routing.executionMode === "recommended") {
            let qaArgs: Record<string, unknown> = {};
            try { qaArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep {} */ }
            quickActions.push({
              id: `quick-${quickActions.length}`,
              text: humanizeQuickAction(toolName, qaArgs),
              confidence: 0.9,
              type: "quick_action",
              quickAction: { tool: toolName, args: qaArgs, reason: "Recommended by Co-Pilot" },
            });
            chatMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                ok: true,
                recommended: true,
                executed: false,
                note: "Surfaced to the human agent as a recommended action — NOT executed by the Co-Pilot. Continue and write the suggested reply for the human to send.",
              }),
            } as any);
            logCopilotTool({
              decision: "ACTION",
              plannerReason: plannerReasonForTool(plan, toolName),
              tool: toolName,
              executed: false,
              executionMode: "recommended",
              result: `recommended to human: ${humanizeQuickAction(toolName, qaArgs)}`,
            }, diag);
            continue;
          }

          const res = await dispatchToolCall(
            { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
            toolCtx,
          );
          if (res.sideEffect?.proposeQuickAction) {
            const qa = res.sideEffect.proposeQuickAction;
            quickActions.push({
              id: `quick-${quickActions.length}`,
              text: humanizeQuickAction(qa.tool, qa.args),
              confidence: 0.9,
              type: "quick_action",
              quickAction: qa,
            });
          }
          chatMessages.push({
            role: "tool",
            tool_call_id: res.toolCallId,
            content: res.content,
          } as any);
          logCopilotTool({
            decision: "READ",
            plannerReason: plannerReasonForTool(plan, toolName),
            tool: toolName,
            executed: true,
            executionMode: "background",
            result: summarizeToolResult(res.content),
          }, diag);
        }

        if (terminated) break;
      }

      // Turn-level decision when no READ/ACTION tool ran: a pure reply (NO_TOOL)
      // or blocked on a required input the planner named (MISSING_INFORMATION).
      if (dispatchedToolCount === 0) {
        logCopilotTool(noToolDecision(plan), diag);
      }

      const out = [...finalSuggestions, ...quickActions];
      if (out.length === 0) {
        return [{ id: "no-match", text: "No relevant suggestions for this context.", confidence: 0, type: "info" }];
      }
      return out;
    } catch (err: any) {
      // Abort: caller (voice-assist.triggerAssist) is in charge of the
      // skip-publish decision - re-throw so we don't replace fresh
      // suggestions with a stale "AI suggestion error" placeholder.
      if (isAbortError(err)) throw err;
      console.error("OpenAI suggestion error:", err.message);
      return [{ id: "error", text: "Failed to get AI suggestions. Check API key and model configuration.", confidence: 0, type: "info" }];
    }
  }

  async summarize(context: ConversationContext): Promise<string> {
    const config = context.copilotConfig;
    if (config && !config.isActive) return "Co-Pilot is disabled.";

    const model = config?.model || this.defaultModel;
    const messagesText = context.messages
      .filter((m) => m.body?.trim())
      .map((m) => `${m.direction === "INBOUND" ? "Customer" : (m.senderName || "Agent")}: ${m.body}`)
      .join("\n");

    if (!messagesText) return "No messages to summarize.";

    const langInstruction = context.locale && context.locale !== "en"
      ? `\n\nRespond in ${LOCALE_NAME[context.locale] || context.locale}.`
      : "";

    try {
      const result = await generateResponse({
        tenantId: context.tenantId || "",
        sessionId: context.conversationId,
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a CRM analyst summarizing a customer conversation for the sales/support team.\n" +
              "Read the WHOLE conversation and infer the customer's REAL intent - do NOT take the opening word literally. " +
              "Someone who opens with \"support\"/\"תמיכה\" but then asks what the product does, what it can do, and how it works is doing PRODUCT DISCOVERY / PRE-SALES, not support. Classify by what they actually explored, not the first word.\n\n" +
              "Write concise bullet points with this structure:\n" +
              "• **Why they reached out**: the customer's true underlying intent across the whole conversation (e.g. exploring the product, evaluating a specific capability, a real support issue, pricing). Be specific about the topic.\n" +
              "• **What they asked**: the concrete questions or topics they explored, as a short sub-list when there were several.\n" +
              "• **Status**: where things stand from the CUSTOMER's side (e.g. exploring, asked X and awaiting an answer, ready to buy, issue resolved). A human agent reads this AFTER claiming the conversation - they ARE the human now handling it - so never phrase status as \"waiting to be connected to a human agent\" or \"needs to be handed off\"; describe what the customer actually needs next.\n" +
              "• **Opportunity**: any sales/expansion signal - interest in a capability, evaluation intent, buying signal. Write \"none clear\" if genuinely absent. Do NOT invent one.\n\n" +
              "Rules: ground every point in what was actually said - never fabricate. Don't mislabel a discovery/evaluation chat as \"support\". Keep it brief." + langInstruction,
          },
          { role: "user", content: messagesText },
        ],
        temperature: 0.3,
        maxTokens: 256,
        metadata: { type: "summary", conversationId: context.conversationId },
      });

      return result.content || "Unable to generate summary.";
    } catch (err: any) {
      console.error("OpenAI summary error:", err.message);
      return "Failed to generate summary.";
    }
  }

  async classifyIntent(message: string): Promise<IntentClassification> {
    try {
      const result = await generateResponse({
        tenantId: "",
        model: this.defaultModel,
        messages: [
          { role: "system", content: 'Classify the customer message intent. Return JSON: { "intent": string, "confidence": number 0-1, "entities": [{ "type": string, "value": string }] }. Common intents: greeting, inquiry, complaint, cancellation, billing, technical_support, feedback, other.' },
          { role: "user", content: message },
        ],
        temperature: 0,
        maxTokens: 128,
        responseFormat: { type: "json_object" },
        metadata: { type: "classification" },
      });

      const content = result.content;
      if (!content) return { intent: "unknown", confidence: 0, entities: [] };
      return JSON.parse(content);
    } catch {
      return { intent: "unknown", confidence: 0, entities: [] };
    }
  }

  async classifySentiment(text: string): Promise<{ sentiment: string; score: number }> {
    if (!text?.trim()) return { sentiment: "neutral", score: 0 };
    try {
      const result = await generateResponse({
        tenantId: "",
        model: this.defaultModel,
        messages: [
          {
            role: "system",
            content:
              'Read the customer\'s messages and judge their overall sentiment toward the company/product across the whole conversation. ' +
              'Return JSON: { "sentiment": "positive"|"neutral"|"negative"|"mixed", "score": number from -1 (very negative) to 1 (very positive) }. ' +
              'An engaged, curious customer asking lots of questions is "positive". Only "negative" when they express real frustration, complaint, or dissatisfaction. Judge the substance, not the politeness words.',
          },
          { role: "user", content: text },
        ],
        temperature: 0,
        maxTokens: 64,
        responseFormat: { type: "json_object" },
        metadata: { type: "sentiment" },
      });
      const content = result.content;
      if (!content) return { sentiment: "neutral", score: 0 };
      const parsed = JSON.parse(content);
      const sentiment = ["positive", "neutral", "negative", "mixed"].includes(parsed.sentiment) ? parsed.sentiment : "neutral";
      const score = typeof parsed.score === "number" ? Math.max(-1, Math.min(1, parsed.score)) : 0;
      return { sentiment, score };
    } catch {
      return { sentiment: "neutral", score: 0 };
    }
  }

  async chatWithAgent(params: AgentChatParams): Promise<string> {
    const config = params.copilotConfig;
    if (config && !config.isActive) return "Co-Pilot is disabled.";

    const model = config?.model || this.defaultModel;

    let customerBlock: string | undefined;
    if (params.customerData) {
      const cd = params.customerData;
      const lines = [
        "## Customer & Conversation Info",
        `- Name: ${cd.name || "Unknown"}`,
        `- External ID / Phone: ${cd.externalId}`,
        `- Channel: ${cd.channel}`,
        `- Conversation Status: ${cd.status}`,
        cd.department && `- Department: ${cd.department}`,
        cd.assignedAgent && `- Assigned Agent: ${cd.assignedAgent}`,
        `- Conversation Started: ${cd.createdAt}`,
        cd.lastMessageAt && `- Last Message: ${cd.lastMessageAt}`,
        `- Handed Over to Human: ${cd.isHandedOver ? "Yes" : "No"}`,
      ].filter(Boolean) as string[];
      customerBlock = lines.join("\n");
    }

    // BEL - copilot CHAT mode (or whatever copilotPreferredMode says).
    const lastInbound = [...params.messages].reverse().find((m) => m.direction === "INBOUND");
    const chatBehavior = computeBehaviorState({
      mode: "copilot",
      identity: {
        hasContact: !!params.customerData?.externalId,
        contactLifecycle: null,
        priorConversationCount: 0,
      },
      request: {
        lastMessage: lastInbound?.body || params.agentMessage || "",
        messageCount: params.messages.length,
        recentDirections: params.messages.slice(-5).map((m) => m.direction),
        recentInboundTexts: params.messages
          .filter((m) => m.direction === "INBOUND")
          .slice(-5)
          .map((m) => m.body || ""),
      },
      copilotPreferredMode: config?.copilotMode ?? "CHAT",
    });

    // KB gated by BEL.
    let kbBlock: string | undefined;
    try {
      const query = params.agentMessage || lastInbound?.body || "";
      if (query && params.tenantId && shouldRetrieveKB(chatBehavior, query)) {
        const chunks = await retrieveRelevantChunks(params.tenantId, query, 5);
        if (chunks.length > 0) kbBlock = buildKnowledgeContext(chunks) || undefined;
      }
    } catch { /* KB not available, continue without */ }

    // Build tool surface BEFORE prompt so capability whitelist renders correctly.
    let chatContactId: string | undefined;
    if (params.tenantId && params.customerData?.externalId && params.customerData?.channel) {
      const contact = await prisma.contact.findFirst({
        where: {
          tenantId: params.tenantId,
          channel: params.customerData.channel as any,
          externalId: params.customerData.externalId,
        },
        select: { id: true },
      });
      chatContactId = contact?.id;
    }
    // ── SURFACE PARITY ────────────────────────────────────────────────────
    // Copilot CHAT now consumes the EXACT same tool surface as the primary
    // Copilot path — and the same calendar gating the AI Employee uses — via the
    // ONE shared builder, instead of the old generic built-in-only surface that
    // silently dropped the calendar tools and the check_availability handler.
    // Advisory gating (no close / follow-up / escalate) is baked into the builder:
    // the agent asking the copilot a question must never cause a real side-effect
    // on the conversation they already own. No mirrored implementation remains.
    const planAgent = pickAgent(config) as any;
    const chatAgentId: string | null = planAgent?.id ?? null;
    const surface = await assembleCopilotToolSurface({
      tenantId: params.tenantId || "",
      conversationId: params.conversationId,
      aiAgentId: chatAgentId,
      contactId: chatContactId,
      customerExternalId: params.customerData?.externalId,
    });
    const chatTools = surface.tools;
    const chatToolFnNames = surface.toolFunctionNames;
    const calendarBookable = surface.calendarBookable;
    const hasActiveBooking = surface.hasActiveBooking;

    // ── SHARED BRAIN ──────────────────────────────────────────────────────
    // Copilot CHAT reasons over the SAME Current Plan as the AI Employee.
    let planCtx: AssembledPlanContext | undefined;
    try {
      let crmFlags: CrmStateFlags = { hasLead: false, hasContact: false };
      let crmBlock: string | undefined;
      const extId = params.customerData?.externalId;
      if (params.tenantId && extId) {
        const prefetch = await prefetchCrmContext(params.tenantId, params.conversationId, { externalId: extId });
        if (prefetch) {
          crmBlock = renderCrmContextBlock(prefetch) || undefined;
          const hasLead = prefetch.leadMatches.length > 0;
          crmFlags = {
            hasLead,
            hasContact: hasLead || prefetch.contactMatches.length > 0,
            isCustomer: prefetch.contactMatches.length > 0,
          };
        }
      }
      planCtx = await assemblePlanContext({
        tenantId: params.tenantId || "",
        conversationId: params.conversationId,
        role: planAgent?.role || "agent",
        agentId: chatAgentId,
        goal: planAgent?.goal ?? null,
        salesContext: planAgent?.salesContext,
        customer: { channel: params.customerData?.channel || "", externalId: extId },
        crmFlags,
        contextBlocks: { customerBlock, crmBlock },
        messages: params.messages,
      });
      if (crmBlock) customerBlock = [customerBlock, crmBlock].filter(Boolean).join("\n\n");
    } catch (err: any) {
      console.warn("[copilot-chat] plan context assembly failed (non-fatal):", err?.message);
    }

    const promptOpts: BuildPromptOpts = {
      behaviorState: chatBehavior,
      agent: pickAgent(config),
      context: { customerBlock, locale: params.locale },
      knowledge: { block: kbBlock },
      toolFunctionNames: chatToolFnNames,
      toolCapabilityHints: planCtx?.toolCapabilityHints,
      crm: planCtx?.crmFlags,
      completedActionTools: planCtx?.completedActionTools,
      priorGoal: planCtx?.priorGoal,
      wizardFacts: planCtx?.wizardFacts,
      calendarBookable,
      hasActiveBooking,
    };
    const systemPrompt = buildAgentPrompt(promptOpts);

    // ── DIAGNOSTICS ───────────────────────────────────────────────────────
    // Same observability as the primary path: log the EXACT plan the prompt
    // rendered, then route every tool call through routeCopilotTool below.
    const diag: CopilotDiagContext = {
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      entry: "chat",
    };
    const plan = computeCurrentPlanForOpts(promptOpts);
    logCopilotPlan(plan, diag);
    let dispatchedToolCount = 0;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: renderOutputContractInstruction(chatBehavior.outputContract) },
    ];

    const transcript = params.messages
      .filter((m) => m.body?.trim())
      .map((m) => {
        if (m.direction === "INBOUND") {
          return `[Customer${params.customerName ? ` - ${params.customerName}` : ""}]: ${m.body}`;
        }
        return `[Agent${m.senderName ? ` - ${m.senderName}` : ""}]: ${m.body}`;
      })
      .join("\n");
    if (transcript) {
      messages.push({ role: "user", content: `## Live Conversation Transcript\n${transcript}` });
    }

    for (const msg of params.chatHistory) {
      messages.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
    }

    messages.push({ role: "user", content: params.agentMessage });

    // PLANNER-OWNED EXECUTION (Runtime before LLM, ADVISORY) — identical to suggest.
    if (isCalendarRuntimeEnabled(params.tenantId || "") && plan) {
      const pre = await preResolveCalendarRead({
        objective: plan.currentObjective,
        calendarBookable,
        hasActiveBooking,
        mode: "advisory",
        context: { tenantId: params.tenantId || "", conversationId: params.conversationId, customerExternalId: params.customerData?.externalId ?? undefined, aiAgentId: chatAgentId ?? undefined },
        port: copilotCalPort,
      });
      if (pre.block) messages.push({ role: "system", content: pre.block });
    }

    // contactId + tools were computed above for the capability whitelist. mode +
    // the check_availability READ handler mirror the primary path exactly, so the
    // CHAT Copilot auto-runs availability checks (never inventing times) and routes
    // gate decisions through the same copilot side-effect path.
    const toolCtx: AgentToolContext = {
      tenantId: params.tenantId || "",
      conversationId: params.conversationId,
      contactId: chatContactId,
      authToken: process.env.INTERNAL_SERVICE_TOKEN,
      mode: "copilot",
      checkAvailability: surface.checkAvailabilityHandler,
    };
    const tools = chatTools;

    try {
      for (let round = 0; round < 3; round++) {
        const result = await generateResponse({
          tenantId: params.tenantId || "",
          sessionId: params.conversationId,
          model,
          messages,
          temperature: config?.temperature ?? 0.7,
          maxTokens: config?.maxTokens ?? 1024,
          metadata: { type: "chat", conversationId: params.conversationId },
          tools,
        });

        const toolCalls = result.toolCalls;
        if (!toolCalls || toolCalls.length === 0) {
          // Turn-level decision when no READ/ACTION tool ran: pure reply (NO_TOOL)
          // or blocked on a planner-named required input (MISSING_INFORMATION).
          if (dispatchedToolCount === 0) logCopilotTool(noToolDecision(plan), diag);
          return result.content || "I couldn't generate a response. Please try again.";
        }

        messages.push({
          role: "assistant",
          content: result.content || "",
          tool_calls: toolCalls,
        } as any);

        for (const tc of toolCalls) {
          // DECISION ENGINE: identical to the primary path — route through the
          // shared routeCopilotTool. Safe READ tools auto-run; customer-facing
          // ACTIONS are recommended to the human, never executed.
          const toolName = tc.function?.name || "";
          dispatchedToolCount++;

          // CALENDAR → the ONE runtime pipeline (ADVISORY), identical to suggest.
          if (isCalendarTool(toolName)) {
            let calArgs: Record<string, unknown> = {};
            try { calArgs = JSON.parse(tc.function.arguments || "{}"); } catch { /* {} */ }
            const adv = await executeCalendarToolAdvisory({
              toolName,
              toolArgs: calArgs,
              context: { tenantId: params.tenantId || "", conversationId: params.conversationId, customerExternalId: params.customerData?.externalId ?? undefined, aiAgentId: chatAgentId ?? undefined },
              port: copilotCalPort,
              plannerGoal: plan?.goal ?? undefined,
            });
            messages.push({ role: "tool", tool_call_id: tc.id, content: adv.content } as any);
            logCopilotTool({
              decision: adv.quickAction ? "ACTION" : "READ",
              plannerReason: plannerReasonForTool(plan, toolName),
              tool: toolName,
              executed: !adv.quickAction,
              executionMode: adv.quickAction ? "recommended" : "background",
              result: summarizeToolResult(adv.content),
            }, diag);
            continue;
          }

          const routing = routeCopilotTool(toolName);
          if (routing.executionMode === "recommended") {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                ok: true,
                recommended: true,
                executed: false,
                note: "Surfaced to the human agent as a recommended action — NOT executed by the Co-Pilot. Tell the agent you recommend this action and why it advances the goal.",
              }),
            } as any);
            logCopilotTool({
              decision: "ACTION",
              plannerReason: plannerReasonForTool(plan, toolName),
              tool: toolName,
              executed: false,
              executionMode: "recommended",
              result: "recommended to human (not executed)",
            }, diag);
            continue;
          }
          const res = await dispatchToolCall(
            { id: tc.id, function: { name: toolName, arguments: tc.function.arguments } },
            toolCtx,
          );
          messages.push({
            role: "tool",
            tool_call_id: res.toolCallId,
            content: res.content,
          } as any);
          logCopilotTool({
            decision: "READ",
            plannerReason: plannerReasonForTool(plan, toolName),
            tool: toolName,
            executed: true,
            executionMode: "background",
            result: summarizeToolResult(res.content),
          }, diag);
        }
      }
      return "I couldn't finalize a response after using tools. Please try again.";
    } catch (err: any) {
      console.error("OpenAI agent chat error:", err.message);
      return "Failed to get AI response. Please check API configuration.";
    }
  }

  private buildChatMessages(
    context: ConversationContext,
    systemPrompt: string,
    state: BehaviorState,
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      // Output contract instruction sourced from BEL (NOT agent.copilotMode at provider time).
      { role: "user", content: renderOutputContractInstruction(state.outputContract) },
    ];

    const transcript = context.messages
      .filter((msg) => msg.body?.trim())
      .map((msg) => {
        if (msg.direction === "INBOUND") {
          return `[Customer${context.customerName ? ` - ${context.customerName}` : ""}]: ${msg.body}`;
        }
        return `[Agent${msg.senderName ? ` - ${msg.senderName}` : ""}]: ${msg.body}`;
      })
      .join("\n");

    if (transcript) {
      messages.push({ role: "user", content: `## Conversation Transcript\n${transcript}` });
    }

    return messages;
  }
}

const LOCALE_NAME: Record<string, string> = {
  he: "Hebrew", ar: "Arabic", en: "English", es: "Spanish",
  fr: "French", de: "German", pt: "Portuguese", ru: "Russian",
  zh: "Chinese", ja: "Japanese",
};

function humanizeQuickAction(toolName: string, args: Record<string, unknown>): string {
  const slug = toolName.startsWith("integration_") ? toolName.slice("integration_".length) : toolName;
  const verb = slug.replace(/_/g, " ");
  const preview = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return preview ? `${verb} - ${preview}` : verb;
}
