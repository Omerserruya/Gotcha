/**
 * Autonomous AI bot reply generator (server-side).
 *
 * SOLE owner of the LLM call for the autonomous "/agent" mode. Every turn:
 *   1. Collect runtime data (agent, conversation, history, CRM, approvals).
 *   2. Compute BehaviorState (BEL is the ONLY decision layer).
 *   3. Build the system prompt (PB consumes BehaviorState; never decides).
 *   4. Filter tools using ONLY `state.allowedActions` - no ad-hoc filters.
 *   5. Run the tool-calling loop.
 *   6. Audit BehaviorState (with provenance) + tool calls.
 *
 * Spec rule #2: tool availability comes ONLY from BehaviorState.allowedActions.
 * Spec rule #3: KB retrieval is gated ONLY by `shouldRetrieveKB(state, ...)`.
 */

import {
  prisma,
  buildAgentToolsForAIAgent,
  dispatchToolCall,
  evaluatePolicies,
  INTEGRATION_CREATE_LEAD_TOOL,
  INTEGRATION_CREATE_CONTACT_TOOL,
  checkAiAllowed,
} from "@chatcenter/shared";
import type { AgentToolDispatchResult } from "@chatcenter/shared";
import { withProtectedAtoms } from "@chatcenter/shared";
import { capabilitiesFor, MAX_CAROUSEL_ITEMS } from "@chatcenter/shared";
import {
  readGrammaticalAddress,
  updateGrammaticalAddress,
  validateGrammaticalAgreement,
  shouldRegenerateForAddress,
} from "@chatcenter/shared";
import { runProductDiscoveryTurn, recordDiscoverySearchOutcome, groundProductSearchResult, isProductSearchTool } from "./discovery-integration.service";
import { buildKeyedModelSummary, renderGroundedProductReply, renderCandidatesForWhatsApp, type ProductSearchEnvelope } from "./product-search.service";
import {
  planAutoRecommendation,
  reasonForCandidate,
  reportCarouselFallback,
} from "./recommendation-autosend.service";
import { buildAICommerceSnapshot, formatCommerceSnapshotForPrompt } from "./commerce-ai-snapshot.service";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { randomUUID } from "crypto";
import {
  validateGroundedMessage,
  buildFallbackMessage,
  reasonPhrase,
  type ExecutionFacts,
} from "./grounded-message.service";
import { validateActionHonesty, stripUnsupportedDelegation } from "./action-honesty.service";
import {
  containsPrivateShopifyData,
  redactString,
} from "./connectors/shopify-safe-output";
import {
  buildOutcome,
  validateOutcomeClaims,
  stripUnsupportedClaims,
  buildOutcomeFactBlock,
  isInterimOnlyReply,
} from "./customer-outcome.service";
import { assertOrderTargetMatchesTurn, isOrderStateChangingTool } from "./order-reference.service";
import {
  detectVariantIntent,
  buildVariantIntentDirective,
  detectCouponIntent,
  buildCouponUnsupportedDirective,
  detectOrderNoteIntent,
  buildOrderNoteDirective,
} from "./product-intent.service";
import {
  detectMissingItemIntent,
  buildMissingItemDirective,
  buildEstablishedIdentityBlock,
  detectProfileUpdateIntent,
  buildProfileUpdateDirective,
  detectOrderAddressIntent,
  buildOrderAddressDirective,
  detectExchangeIntent,
  buildExchangeDirective,
  detectReturnIntent,
} from "./customer-request-intents.service";
import { getReturnProvider, buildReturnDirective } from "./return-provider.service";
import {
  runFlowController,
  renderFlowDirective,
  assertMatchesResolvedFlow,
  orderNameFromMessage,
  type FlowDecision,
} from "./shopify-flow-controller.service";
import {
  detectDocumentRequest,
  resolveDocumentCapability,
  buildDocumentDirective,
} from "./document-request.service";
import { getActionOrchestrator, type ExecutionResult } from "./orchestrator";
import type { AgentToolContext } from "@chatcenter/shared";
import { generateResponse, getDefaultModel, getMicroModel } from "./ai.service";
import { isAgentArchitectureEnabled } from "@chatcenter/shared";
import { runShadowEvaluationInBackground, toShadowContext } from "./reasoner/shadow-runner";
import { agentLoopMode } from "./agent-loop/flags";
import { agentKernelEligible } from "./agent-loop/operation-status"; // TEMPORARY migration routing floor
import { runAgentLoopForBotTurn } from "./agent-loop/bot-loop-adapter";
import { executeAction, type PlannedAction } from "./action-executor.service";
import { beginTurn, isAbortError } from "./turn-cancellation.service";
import { validateAndPersist } from "./output-validator.service";
import {
  createTurnBudget,
  BudgetExceededError,
  auditBudgetAbort,
} from "./cost-budget.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "./knowledge.service";
import { prefetchCrmContext, renderCrmContextBlock, invalidateCrmPrefetch } from "./crm-prefetch.service";
import { getCrmAdapter } from "./connectors/crm-adapter-resolver";
import type { CrmVendor } from "./connectors/crm-adapter.types";
import { resolveIdentity } from "./intelligence-ingest.service";
import { resolveActiveStage } from "./intelligence/stage-resolver.service";
import type { StageContextForPrompt } from "./intelligence/prompts/blocks/copilot-config-block";
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
  type LastAssistantMove,
} from "./behavior-engine.service";
import type { ActionCategory } from "./behavior-strategies";
import {
  buildConversationMemory,
  renderMemoryBlock,
} from "./conversation-memory.service";
import { loadFunnelForTenant } from "./funnel-config.repo";
import { missingContractInputs } from "./tool-contracts";
import { computeProspectState, type ProspectState } from "./prospect-state";
import {
  selectActiveObjective,
  commitObjective,
  resolveGoalObjective,
  type ActiveGoalSnapshot,
  resolveNextActions,
  hasViableAdvancingAction,
  guaranteedBackgroundActions,
  isCreationToolAllowed,
  EMPTY_WIZARD_FACTS,
  isPassiveCloser,
  isNonAdvancingReply,
  customerIsClosing,
  buildCloserCorrective,
} from "./objectives";
import {
  evaluateGoalStatus,
  presentBusinessOutcomes,
  businessOutcomesFromLedger,
  buildGoalPendingCorrective,
} from "./goal-evaluator";
import { groupToolsIntoCapabilities } from "./capabilities";
import { assemblePlanContext } from "./plan-context.service";
import { roleToSkill, requiredKnowledgeFor } from "./skills";
import { computeKnowledgeLedger } from "./knowledge-ledger";
import {
  makeScheduleMeetingHandler,
  makeCheckAvailabilityHandler,
  makeRescheduleMeetingHandler,
  makeCancelMeetingHandler,
  resolveActiveBooking,
  type ActiveBooking,
} from "./schedule-handler.service";
import { computeCalendarCapability, type CalendarCapabilityDetail } from "./calendar-capability.service";
import { getCompanyContext, type CompanyContext } from "./company-context.service";
import {
  detectBookingCommitment,
  detectBookingClaim,
  detectBookingAssertion,
  isBookingAssertionUngrounded,
  buildBookingFailsafeCorrective,
  buildBookingGroundingCorrective,
  buildBookingGroundingFallback,
  detectRedundantInfoRequest,
  buildRedundantInfoCorrective,
} from "./booking-guard.service";
import { TurnOutcomeLedger } from "./turn-outcome-ledger";
import {
  buildCommittedOutcomeBlock,
  evaluateReplyConsistency,
  buildUnconfirmedCommitCorrective,
} from "./ledger-reply";
import { actionCategoriesForTool } from "./side-effect-classifier";
import { listCustomApiTools, executeCustomApiTool } from "./connectors/custom-api.service";
import {
  executeAdapterTool,
  listAdapters,
  missingScopesFromConfig,
  toolBlockedByMissingScopes,
  capabilityStateIsFresh,
  refreshCapabilityState,
  getToolPriority,
} from "./connectors/integration-framework";
import {
  loadActionContracts,
  loadContractProgress,
  markContractToolCompleted,
  markContractPaused,
  type ActionContract,
} from "./action-contracts.repo";
import { tryEmit } from "./notifications-emit";
import { prepareShopifyTurn } from "./shopify-chat-turn.service";
import type { SystemEventType } from "./notifications-emit";
import { guardCustomerReply, turnEvidenceFrom } from "./reply-guard.service";

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

/**
 * Language pin for every INTERNAL corrective we inject as `role: "user"`.
 *
 * Those nudges are our own scaffolding, but to the model they are literally the
 * customer's most recent message - and the system prompt says to detect the
 * reply language from exactly that. Written in English, they silently flip a
 * Hebrew conversation to English on the regenerated turn.
 *
 * Observed live: a fully-Hebrew WhatsApp chat whose Shopify lookup failed got
 * the recovery nudge and answered "Sorry, I can't pull the order from my side
 * right now." - breaking the Language lock the prompt calls NON-NEGOTIABLE.
 *
 * Append this to any injected user-role corrective that leads to a
 * customer-facing reply.
 */
const INTERNAL_NUDGE_LANGUAGE_PIN =
  ` (Internal instruction from the platform - NOT the customer, and NOT a language switch. ` +
  `Your reply must stay in the SAME language the CUSTOMER has been writing in.)`;

function unwrapToolExec(
  toolCallId: string,
  toolName: string,
  exec: ExecutionResult,
): AgentToolDispatchResult {
  if (exec.status === "completed") {
    const inner = exec.result as AgentToolDispatchResult | undefined;
    // Always bind to the CURRENT toolCallId and clone. The ledger dedup path
    // returns the FIRST call's stored result for a duplicate call; without
    // rebinding, two tool messages would share one tool_call_id → OpenAI 400
    // ("Duplicate value for 'tool_call_id'"). Cloning avoids mutating the
    // ledger's stored result object.
    if (inner && typeof inner === "object" && "content" in inner) {
      return { ...inner, toolCallId };
    }
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
    const reason = exec.error ?? "policy";
    // Return a STRUCTURED, actionable result (parity with the other gate
    // results) instead of free-text. Free-text "denied: policy" gave the model
    // no recovery path, so it would re-attempt the same/near-identical call on
    // the next round - burning a full prompt+tools round-trip each time. The
    // explicit instruction tells it to STOP retrying and hand off, which ends
    // the loop early.
    return {
      toolCallId,
      content: JSON.stringify({
        ok: false,
        error: "tool_denied_by_policy",
        tool: toolName,
        reason,
        instruction:
          `You are NOT permitted to use "${toolName}" in this conversation. ` +
          `Do NOT call it again or call a near-identical variant. ` +
          `Continue using the tools you DO have; if the customer genuinely needs this action, ` +
          `use escalate_to_human and tell them a teammate will follow up. ` +
          `Never tell the customer the action succeeded.`,
      }),
      sideEffect: { denied: { reason } as any },
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
// Names are matched as `slug.tool` - the slug part is preserved for context
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
  /**
   * Short ack messages to send as their OWN bubble(s) BEFORE `reply` (e.g.
   * "רגע אחד, בודק 🙏" while a calendar tool runs). The worker sends each of
   * these first, then `reply`. Empty/absent for the normal single-message case.
   */
  interimMessages?: string[];
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
  /**
   * Extra messages the caller must persist AFTER the text reply, in this
   * order. Today that is Shopify product cards / carousels: the model
   * explains its recommendation in `reply`, then the card follows.
   * Empty for every other channel.
   */
  structuredMessages?: Array<{
    messageType: string;
    body: string;
    metadata: Record<string, unknown>;
  }>;
  /**
   * Knowledge sources that actually fed this turn. Populated for every turn
   * (it is one array push per retrieved chunk) and consumed by the sandbox
   * diagnostics panel. Titles only - never chunk text, which can contain
   * customer data.
   */
  knowledgeUsed?: Array<{ title: string; sourceType: string | null }>;
  /**
   * Tool names OFFERED to the model this turn.
   *
   * Distinct from toolCallLog, which records what it actually called. The
   * sandbox diagnostics need both: "no tool was called" and "no tool was
   * available" look identical from the transcript, and they send an operator
   * to completely different places.
   */
  toolsOffered?: string[];
}

function toAgentRecord(row: any): AgentRecord {
  return {
    name: row.name,
    role: row.role,
    // description removed per spec - see prompt-builder AgentRecord.
    tone: row.tone,
    style: row.style,
    identity: row.identity,
    goals: row.goals,
    goal: row.goal ?? null,
    successCriteria: row.successCriteria ?? null,
    toneConfig: row.toneConfig,
    behavioral: row.behavioral,
    persona: row.persona,
    salesContext: row.salesContext,
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
 * Detect a human-handoff REQUEST. Must require an action verb context - the
 * customer is asking to talk to a human, not describing their own team.
 *
 * \b doesn't work for Hebrew in JavaScript (non-ASCII letters aren't word
 * characters), so the original `/\b(נציג)\b/` matched inside "נציגים"
 * (12 representatives) and triggered false escalations. Patterns below
 * require a verb of asking/requesting paired with the noun.
 */
const HUMAN_HANDOFF_PATTERNS = [
  // English - explicit request
  /\b(speak|talk|connect|chat|transfer|put me through)\s+(to|with|me)\s+(?:to\s+)?(?:an?\s+|the\s+)?(human|agent|person|someone|rep|representative)\b/i,
  /\b(can\s+i|i\s+(?:want|need|wanna|would like))\s+(to\s+)?(speak|talk|chat)\s+(to|with)\s+(?:an?\s+|the\s+)?(human|agent|person|someone|rep)\b/i,
  /\b(give|get|connect)\s+me\s+(?:to\s+)?(?:an?\s+|the\s+)?(human|agent|person|rep)\b/i,
  /\bnot\s+a\s+bot\b/i,
  // Hebrew - explicit request only. Word boundaries via space/start/end.
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
 * Deterministic escalation gates, evaluated PRE-BEL.
 *
 * Mirrors the worker-side `checkEscalationThresholds` (incoming-worker/
 * src/services/ai-bot.service.ts) so direct callers of the AI service
 * (not just the worker) cannot bypass them. When any gate trips, the
 * caller passes `flags.escalationGateFired: true` into the BEL, which
 * forces strategy=RESOLVE + escalationPressure=escalate_now + required
 * action `escalate_to_human` - the same path a worker-side trip takes.
 *
 * ── Map of what actually escalates to a human (and what must NOT) ──
 *   ESCALATE when:
 *     1. The customer EXPLICITLY asks for a human - handled separately by
 *        `detectHumanHandoff` → `humanHandoffRequested` (always escalates).
 *     2. RUNAWAY loop: OUTBOUND ai_bot messages reach the HARD ceiling
 *        (2× the per-agent message cap) - unconditional safety backstop.
 *     3. STALLED: the AI has gone past the soft message cap OR past
 *        `maxAutonomousMinutes` WITHIN THE CURRENT ACTIVE BURST, AND the goal
 *        is not viable (no advancing action left).
 *   NEVER escalate just because:
 *     - the TOTAL conversation is old. The timer measures the CURRENT burst
 *       (`autonomousSinceAt` = first message after the last long gap), so a
 *       customer returning hours/days later to reschedule starts fresh and is
 *       NOT handed to a human for crossing a counter.
 *     - the goal is still viable (engaged + reachable, or an actionable
 *       scheduling request the AI can fulfil) - see `goalViable`.
 *     - a vague/short answer, a normal discovery turn, or a background tool
 *       failure (handled by Quality Contract rule 4a, not here).
 */
async function evaluateEscalationGates(opts: {
  tenantId: string;
  conversationId: string;
  config: { maxAutonomousMessages: number | null; maxAutonomousMinutes: number | null };
  /**
   * Start of the CURRENT autonomous burst (not conversation.createdAt). A burst
   * resets after a long quiet gap, so the minutes cap reflects "how long has the
   * AI been going in THIS exchange", not the conversation's lifetime age.
   */
  autonomousSinceAt: Date;
  // GOAL PRESERVATION: when the business objective is still viable (we can reach
  // the customer AND they're actively engaged, OR the customer is asking for an
  // action the AI can complete such as book/reschedule/cancel), the soft
  // message/time caps are SUPPRESSED - a hot lead one message from booking must
  // not be handed to a human just for crossing a counter. A hard ceiling (2x the
  // message cap) is still enforced as the safety backstop against runaway loops.
  goalViable: boolean;
}): Promise<boolean> {
  const maxMsgs = opts.config.maxAutonomousMessages || 30;
  const hardCeiling = maxMsgs * 2;
  try {
    const aiMessageCount = await prisma.message.count({
      where: {
        conversationId: opts.conversationId,
        tenantId: opts.tenantId,
        direction: "OUTBOUND",
        metadata: { path: ["source"], equals: "ai_bot" },
      },
    });
    if (aiMessageCount >= hardCeiling) {
      console.log(
        `[ai-bot] escalation gate tripped (HARD ceiling): ai_messages=${aiMessageCount} ceiling=${hardCeiling} convo=${opts.conversationId}`,
      );
      return true;
    }
    if (aiMessageCount >= maxMsgs) {
      if (opts.goalViable) {
        console.log(
          `[ai-bot] soft msg cap reached (${aiMessageCount}/${maxMsgs}) but objective is viable + customer engaged - NOT escalating (goal preservation). convo=${opts.conversationId}`,
        );
      } else {
        console.log(
          `[ai-bot] escalation gate tripped: ai_messages=${aiMessageCount} cap=${maxMsgs} (no viable advancing action) convo=${opts.conversationId}`,
        );
        return true;
      }
    }
  } catch (err: any) {
    // Fail-open on transient DB error - the worker still has its own
    // copy of this check; don't block legitimate replies because the
    // metadata-path query hiccupped.
    console.warn("[ai-bot] escalation gate count failed (non-fatal):", err?.message);
  }

  const maxMins = opts.config.maxAutonomousMinutes || 15;
  const minutesElapsed = (Date.now() - opts.autonomousSinceAt.getTime()) / 60000;
  if (minutesElapsed >= maxMins && !opts.goalViable) {
    console.log(
      `[ai-bot] escalation gate tripped: burst_elapsed=${Math.round(minutesElapsed)}m cap=${maxMins}m (no viable advancing action) convo=${opts.conversationId}`,
    );
    return true;
  }

  return false;
}

// Regex marking a successful tool result (`{"ok":true,...}`). Used to tell a
// tool that merely DISPATCHED from one that actually SUCCEEDED.
const TOOL_OK_RE = /"ok"\s*:\s*true/;

// loadCommittedActionTools, loadCommittedGoal and loadToolCapabilityHints now
// live in plan-context.service.ts (assemblePlanContext) - the single source of
// truth shared by the AI Employee and the AI Copilot.

/**
 * Filter the LLM tool surface using ONLY `state.allowedActions`. The BEL
 * has already accounted for strategy, autonomy, CRM existence, and pending
 * approvals; this function performs the deterministic name → category
 * mapping and drops anything outside the allowed set.
 *
 * Always-keep: escalate_to_human, submit_*, integration_*_search/_get/_lookup/_read.
 */
// `actionCategoriesForTool` now lives in side-effect-classifier.ts (single
// source of truth, shared with the Turn Outcome Ledger). Imported at top.

/**
 * Programmatic exit-criteria gate for `close_conversation`. The funnel
 * stage's `mustHaveFields` are rendered into the prompt as instructions,
 * but the LLM can still call `close_conversation` while fields are
 * missing. This gate intercepts the dispatch and refuses to close
 * until each `mustHaveField` has evidence (contact-row value OR
 * transcript mention).
 *
 * Evidence model (best-effort, conservative):
 *   - `email` / `phone`: presence on the resolved Contact row, or
 *     extractable from any inbound message body via regex.
 *   - generic field: case-insensitive substring of the field label
 *     appears in the concatenated transcript (catches "budget", "ICP",
 *     "timeline"…). False positives are tolerable; the LLM will be
 *     asked to confirm anyway.
 *
 * Limitations:
 *   - `name` is not enforced (too many false positives on first names
 *     embedded in greetings); the LLM's structured outputs handle it.
 *   - Stage-advance tools (vendor-specific) are NOT gated here; only
 *     `close_conversation` is, because it is the unambiguous "done"
 *     signal across tenants.
 */
/**
 * Required-input gate: returns the tool's schema-`required` fields that are
 * MISSING from the model's call. OpenAI does NOT enforce `required`, so a tool
 * can be called with a half-formed argument set (e.g. refund_order with no
 * order_id). This is the structural backstop behind the BLOCK 0 Tool Execution
 * Contract: a write never fires until its genuinely-required inputs exist.
 *
 * Uses each tool's own JSON-schema `required` array - so tools that are designed
 * to be callable with minimal args (e.g. schedule_meeting, which lets the server
 * propose slots) are intentionally NOT over-constrained here.
 */
export function missingRequiredArgs(
  toolName: string,
  args: Record<string, unknown>,
  tools: any[],
): string[] {
  const tool = (tools || []).find((t) => t?.function?.name === toolName);
  const required = tool?.function?.parameters?.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  return required.filter((k: string) => {
    const v = (args as any)?.[k];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
}

function checkExitCriteriaGate(
  toolName: string,
  stageContext: StageContextForPrompt | undefined,
  evidence: { email?: string | null; phone?: string | null; transcript: string },
): { blocked: boolean; reason?: string; missing?: string[]; stageLabel?: string } {
  if (toolName !== "close_conversation") return { blocked: false };
  const mustHave = stageContext?.copilot?.exitCriteria?.mustHaveFields ?? [];
  if (!mustHave.length) return { blocked: false };

  const transcript = evidence.transcript || "";
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const phoneRe = /(\+?\d[\d\s\-().]{7,}\d)/;

  const missing: string[] = [];
  for (const fieldRaw of mustHave) {
    const field = String(fieldRaw || "").trim();
    if (!field) continue;
    const lower = field.toLowerCase();

    if (lower === "email") {
      if (evidence.email && evidence.email.trim()) continue;
      if (emailRe.test(transcript)) continue;
      missing.push(field);
      continue;
    }
    if (lower === "phone" || lower === "phone_number" || lower === "mobile") {
      if (evidence.phone && evidence.phone.trim()) continue;
      if (phoneRe.test(transcript)) continue;
      missing.push(field);
      continue;
    }
    if (lower === "name" || lower === "full_name" || lower === "first_name") {
      // Too noisy to enforce - defer to LLM/structured fields.
      continue;
    }

    // Generic: substring of the field label must appear somewhere in
    // the transcript. Escape regex metachars defensively.
    const safe = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fieldRe = new RegExp(`\\b${safe}\\b`, "i");
    if (!fieldRe.test(transcript)) missing.push(field);
  }

  if (missing.length === 0) return { blocked: false };

  return {
    blocked: true,
    reason:
      `Cannot close - funnel stage \`${stageContext?.label ?? stageContext?.id ?? "current"}\` ` +
      `requires fields not yet captured: ${missing.map((m) => `\`${m}\``).join(", ")}. ` +
      `Ask the customer for each missing field before calling \`close_conversation\` again.`,
    missing,
    stageLabel: stageContext?.label,
  };
}

// (Removed: `checkAllowedActionsGate` and `checkContractGate` - both were disabled
// stubs that returned `{blocked:false}` by user mandate. Their only call sites (in the
// tool-dispatch loop) were therefore unreachable and have been removed. Move-selection
// is still steered by the behavior prompt; the action taxonomy still powers
// `computeUnmetRequiredActions`; contract progress is still tracked in the loop.)

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
    if (!matchingTool) continue; // No tool exists for this action - not a violation.
    // Was any tool that maps to this action called?
    const wasCalled = [...calledToolNames].some((called) => actionCategoriesForTool(called).includes(action));
    if (!wasCalled) unmet.push({ action, toolName: matchingTool });
  }
  return unmet;
}

// OUTCOME QUALITY > DATA COLLECTION. Generic, role-agnostic surface filter: a
// record should be created only when creation is meaningful business progress,
// never just because enough fields exist. Two universal rules:
//   (1) a poor-fit prospect (judgment fit="disqualified") → create NOTHING;
//   (2) a high-commitment object (deal/opportunity/quote/order/contract/invoice)
//       requires a real, known contact to attach to (prospectState ≠ NEW_PROSPECT)
//       - you don't open a deal/opportunity for an anonymous or unqualified party.
// Capture objects (lead/contact/ticket/case) remain available for engaged
// prospects. Works for any role and any future creation tool by name shape.
function filterCreationToolsByEngagement(
  tools: any[],
  ctx: { fit: "qualified" | "disqualified" | "neutral"; prospectState: ProspectState },
): any[] {
  return (tools as any[]).filter((t) => isCreationToolAllowed(t?.function?.name || "", ctx));
}

function filterToolsByAllowedActions(tools: any[], state: BehaviorState): any[] {
  // Strategy-based tool gating is DISABLED - the agent gets the full tool
  // surface (escalate, schedule_*, create_lead, close, etc.) on every turn
  // regardless of strategy. The behavior prompt (allowedActions /
  // forbiddenBehaviors text rendered into the system prompt) still steers
  // tone and move-selection, but the model can always reach a critical
  // tool when the situation calls for it (e.g. escalate_to_human on a
  // brand-new conversation, schedule_meeting when a customer offers a
  // concrete slot, close_conversation when the customer says goodbye).
  //
  // Previously this filter physically removed schedule_* / write / close
  // tools when the BEL picked QUALIFY or GUIDE - which is the strategy for
  // every message-1 turn and for most informational chats - so the LLM
  // verbalized actions it had no tool for. That mismatch is the bug; the
  // unfiltered surface is the fix.
  //
  // Action Contract sequence gate is preserved: when a blocking contract
  // is mid-execution, the model is still narrowed to the pending tool plus
  // the always-on essentials (escalate, identity link, reads, submits).

  const cs = state.actionContractState;
  if (!cs?.active || !cs.blocking || cs.pendingTools.length === 0) {
    return tools;
  }
  const pendingSet = new Set(cs.pendingTools);
  return tools.filter((t: any) => {
    const name: string | undefined = t?.function?.name;
    if (!name) return true;
    if (name === "escalate_to_human") return true;
    if (name === "link_customer_identifier") return true;
    if (name.startsWith("submit_")) return true;
    if (/(_search|_get|_lookup|_read)$/.test(name)) return true;
    // Scheduling tools are ALWAYS available when surfaced - they're already
    // gated upstream (check_availability + schedule_meeting by calendar
    // capability; reschedule/cancel by an existing booking). A blocking contract
    // mid-booking must NOT strip them, or a customer who returns to check times /
    // move / cancel the meeting can't be served and the bot escalates instead of
    // acting. check_availability is read-only, so it's always safe to keep.
    if (
      name === "check_availability" ||
      name === "schedule_meeting" ||
      name === "reschedule_meeting" ||
      name === "cancel_meeting"
    )
      return true;
    return pendingSet.has(name);
  });
}

/**
 * Extract an email or phone identifier from THIS turn's inbound message.
 * Returns undefined if neither is present. The BEL uses this to drive the
 * ownership signal + identity_link required action (Task 1).
 */
function extractIdentifierFromMessage(
  text: string,
  defaultCountry: string = "IL",
): { kind: "email" | "phone"; value: string } | undefined {
  const trimmed = (text || "").trim();
  if (!trimmed) return undefined;
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const m = trimmed.match(emailRe);
  if (m) return { kind: "email", value: m[0].toLowerCase() };

  // Phone extraction - loose candidate match, then libphonenumber-js validates
  // against the tenant's default country. This way local formats sent in
  // Instagram/Messenger ("054-1234567", "(555) 123-4567", "0541234567")
  // resolve correctly, not just strict E.164 with a leading `+`.
  //
  // Candidate criteria: 7+ digits in a row (with optional separators) AND
  // either a leading `+` OR at least one separator/grouping or a leading
  // zero - that filters out random IDs/order numbers like "1234567890" in
  // body prose. We also reject overly-long digit runs (16+) which are
  // typically card / order numbers, not phones.
  const phoneCandidateRe = /(\+?\d[\d\s().-]{6,}\d)/g;
  for (const match of trimmed.matchAll(phoneCandidateRe)) {
    const raw = match[1];
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    // Cheap year/price guard: bare 4-digit runs without context aren't phones.
    if (digits.length < 8 && !raw.includes("+") && !raw.includes("-") && !raw.includes(" ") && !raw.includes("(")) continue;
    try {
      const parsed = parsePhoneNumberFromString(raw, (defaultCountry || "IL").toUpperCase() as CountryCode);
      if (parsed && parsed.isValid()) {
        return { kind: "phone", value: parsed.number };
      }
    } catch { /* try next candidate */ }
  }
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
// Calendar booking capability is computed by computeCalendarCapability()
// (calendar-capability.service.ts) - a single three-valued signal that gates
// schedule_meeting surfacing, the prompt fail-safe, and the output validator.

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

function renderCustomerInfoBlock(
  conv: any,
  known?: { email?: string; name?: string },
): string | undefined {
  const lines: string[] = ["## Customer & Conversation Info"];
  const name = conv.customerName || known?.name;
  if (name) lines.push(`- Customer Name: ${name}`);
  if (conv.customerExternalId) {
    const isPhone = /^\+?\d{6,}$/.test(String(conv.customerExternalId).replace(/[\s-]/g, ""));
    const label = conv.channel === "WHATSAPP" || isPhone ? "Phone (WhatsApp)" : "External ID";
    const value = conv.channel === "WHATSAPP" && !String(conv.customerExternalId).startsWith("+")
      ? `+${conv.customerExternalId}`
      : conv.customerExternalId;
    lines.push(`- ${label}: ${value}`);
  }
  // Email is the #1 thing the bot wrongly re-asks for ("do you have my email?"
  // → "no, what is it?"). We DO know it (from the transcript / CRM / linked
  // contact, resolved into `resolvedCustomerEmail`); surface it so the bot
  // confirms it instead of denying it. Stable per conversation → cache-safe.
  if (known?.email) lines.push(`- Email: ${known.email}`);
  if (conv.channel) lines.push(`- Channel: ${conv.channel}`);
  if (conv.status) lines.push(`- Conversation Status: ${conv.status}`);
  if (conv.createdAt) lines.push(`- Conversation Started: ${conv.createdAt.toISOString()}`);
  // `lastMessageAt` deliberately omitted - it changes every turn and would
  // break the per-conversation cache prefix. The latest customer message is
  // already in the transcript appended after the system prompt.
  if (lines.length <= 1) return undefined;
  lines.push("");
  lines.push(
    "These are facts you ALREADY have about the customer. Use them when running background " +
      "actions (CRM lookup, lead create/update, tagging), and when the customer asks whether you " +
      "have their details (e.g. their email), CONFIRM the value above - never claim you don't have " +
      "it and never re-ask for information already listed here.",
  );
  // Who this conversation IS, and when that stops being enough. Withheld when
  // the channel proves nothing, so the block never asserts a settled identity
  // that isn't.
  const identityBlock = buildEstablishedIdentityBlock({
    channel: conv.channel,
    customerExternalId: conv.customerExternalId,
  });
  if (identityBlock) {
    lines.push("");
    lines.push(identityBlock);
  }
  return lines.join("\n");
}

/**
 * What to say when the turn produced nothing.
 *
 * Deliberately admits only what is certainly true - that the answer did not
 * come together this time - and offers the one thing that is always available.
 * It claims no action, names no tool and blames no provider, because at this
 * point we genuinely do not know what happened.
 */
function silentTurnFallback(locale: string): string {
  return locale?.startsWith("he")
    ? "סליחה, לא הצלחתי להשלים את הבדיקה הזאת עכשיו. אפשר לנסות שוב, או שאעביר אותך לנציג?"
    : "Sorry - I couldn't finish checking that just now. Shall I try again, or pass you to a person?";
}

function renderPendingApprovalsBlock(pending: Array<{ tool: string }>): string | undefined {
  if (!pending.length) return undefined;
  const list = pending.map((a) => `\`${a.tool}\``).join(", ");
  return [
    "## Pending Approval - IMPORTANT",
    `The following action(s) you proposed earlier are awaiting human approval: ${list}.`,
    "This is the **PENDING_APPROVAL** state (see the Action Outcome Contract). Do NOT call them " +
      "again this turn - the request is already in front of the team. Communicate the REAL state " +
      "honestly: if the customer asks whether it's done, tell them plainly it's gone for approval " +
      "and you'll update them the moment it's confirmed. Be concrete about WHO approves only when " +
      "you actually know it (a named approver, role, or team the context identifies, e.g. \"manager " +
      "approval\" / \"our scheduling team\"); if you do NOT know, do not invent one - say it's gone " +
      "for internal approval by our team. NEVER imply it's already done (\"on it\", \"handling it " +
      "now\", \"booked\"), and NEVER re-ask for details you already have in order to \"retry\" it. " +
      "Convey OWNERSHIP and momentum - make the customer feel YOU are still on it and will come " +
      "back the moment it's approved, not that it vanished into a queue. Treat this as a FIRST-CLASS " +
      "state held across turns: do not auto-retry, do not re-collect info, do not restart the flow " +
      "from the beginning; if the customer returns later, pick up from exactly where it stands. " +
      "CRUCIAL: do NOT let the pending item freeze everything else - keep ADVANCING THE GOAL in " +
      "parallel. Collect the next detail you still need, take the next forward step that does not " +
      "depend on the pending action, and answer their questions. The pending approval blocks ONLY " +
      "that one action, not the whole conversation.",
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

// Final humanizing pass on the customer-facing reply. Models love joining
// clauses with an em/en dash or a spaced hyphen ("…אשמח לעזור - מתי…"), which
// reads as machine-written. Prompt rules reduce it but don't eliminate it, so we
// also strip it deterministically here. Token-internal hyphens (phone numbers,
// "Wi-Fi", date ranges like 10-15) have NO surrounding spaces and are preserved.
function humanizeReply(text: string | null): string | null {
  if (!text) return text;
  // ROOT-CAUSE NOTE (2026-07-20 live incident): a previous version of the dash
  // class here accidentally contained the ASCII hyphen, which rewrote EVERY
  // hyphen - inside product URLs (urban-supply-… → "urban, supply, …"), ISO
  // dates (2026-07-08 → "2026, 07, 08") and image UUIDs - into comma soup on
  // real WhatsApp messages. Two defenses now: the class holds ONLY true wide
  // dashes (U+2014 em, U+2013 en, U+2015 bar), and every transform runs with
  // atomic values (URLs, emails, dates, ids, phones) shielded byte-for-byte
  // via withProtectedAtoms.
  return withProtectedAtoms(text, (prose) => {
    let out = prose;
    // Wide dash used as a clause connector (with or without surrounding spaces).
    out = out.replace(/\s*[—–―]\s*/g, ", ");
    // ASCII hyphen used as a dash: spaces on BOTH sides only. Token-internal
    // hyphens (Wi-Fi, ranges like 10-15) are untouched.
    out = out.replace(/(\S) +- +(\S)/g, "$1, $2");
    // Don't leave a stray ", " right before sentence punctuation or newline.
    out = out.replace(/,\s*([.!?,\n])/g, "$1");
    // Collapse the accidental ", ," and trailing/leading artifacts.
    out = out.replace(/,\s*,/g, ",").replace(/[ \t]{2,}/g, " ");
    return out;
  }).trim();
}

/** Worker-computed "business is closed right now" context (active policy). */
export interface ClosedHoursContext {
  nextOpeningIso: string | null;
  timezone: string;
  nextOpeningText?: { en?: string; he?: string };
}

export async function generateAIBotReply(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  incomingMessage: string;
  /** Present only while the business is CLOSED under the "active" outside-
   *  hours policy (worker-computed from persisted tenant business hours). */
  closedHours?: ClosedHoursContext;
  /**
   * Set only by "Test the AI Employee". The turn is otherwise identical to a
   * live one; this reaches the tool dispatcher, where mutating tools are
   * simulated rather than executed unless the operator opted into "real".
   * Never set by the incoming-worker.
   */
  sandbox?: { enabled: true; writes: "safe" | "real" };
}): Promise<AIBotReplyResult> {
  // Per-conversation cancellation: if a newer inbound for this conversation
  // hits the AI service mid-turn, it calls beginTurn() again which aborts
  // this controller. Every generateResponse() below threads `signal` so the
  // underlying OpenAI fetch is cancelled - no tokens burned, no stale reply
  // emitted. The route layer converts the resulting AbortError into HTTP 499.
  const turn = beginTurn(opts.tenantId, opts.conversationId, "bot");
  try {
    // ── Agent Loop (flag-gated, beside the Planner) ───────────────────────────
    // Capability lifecycle: off → shadow → autonomous (see agent-loop/flags.ts).
    const loopMode = agentLoopMode(opts.tenantId);
    // TEMPORARY migration routing floor (see agent-loop/operation-status.ts): the Kernel
    // may DRIVE a conversation only for an agent explicitly opted in via AGENT_LOOP_AGENTS
    // - one the operator has verified needs nothing beyond autonomous operations. Empty ⇒
    // no agent, so autonomous mode stays safe even before a fully-autonomous employee
    // exists. Deleted together with the Legacy brain (one brain → no routing).
    const kernelDrivesTurn = loopMode === "autonomous" && agentKernelEligible(opts.aiAgentId);

    // AUTONOMOUS - the loop DRIVES the customer turn (real execution). Fail-soft:
    // any loop error falls back to the Planner, so the flag can never break a turn.
    if (kernelDrivesTurn) {
      try {
        const r = await runAgentLoopForBotTurn(opts, "autonomous", turn.signal);
        return { ...r, interimMessages: r.interimMessages };
      } catch (loopErr) {
        if (isAbortError(loopErr)) throw loopErr;
        console.warn("[agent-loop] fell back to planner:", (loopErr as any)?.message ?? loopErr);
      }
    }

    // SHADOW - EVALUATION only. Run the complete loop + Runtime (writes dry-run to
    // RECOMMENDED) to persist iterations/metrics/observations under real traffic, but
    // NEVER surface its output: the legacy Planner remains the customer-facing brain.
    // Fire-and-forget OFF the live turn's critical path (no `turn.signal` - the eval
    // runs to completion independently), fail-soft, so it can neither slow nor break
    // the turn. This is how a capability earns the evidence to graduate to autonomous.
    // Also runs for an autonomous-mode agent NOT (yet) opted into the routing floor, so
    // it keeps accruing evidence until it is eligible.
    if (loopMode === "shadow" || (loopMode === "autonomous" && !kernelDrivesTurn)) {
      void runAgentLoopForBotTurn(opts, "shadow").catch((e) => {
        if (!isAbortError(e)) console.warn("[agent-loop][shadow] eval failed:", (e as any)?.message ?? e);
      });
    }

    return await generateAIBotReplyInner(opts, turn.signal);
  } catch (err) {
    if (isAbortError(err)) {
      throw Object.assign(new Error("aborted-by-newer-turn"), { status: 499, aborted: true });
    }
    throw err;
  } finally {
    turn.end();
  }
}

/**
 * Build the live-conversation fact block fed into the Knowledge Ledger +
 * Objective Engine (via ContextSlot.sessionFactsBlock). Two layers:
 *
 *   1. Structured persisted facts (CustomerProfile.facts) - keyed, so the
 *      ledger matches them language-independently (e.g. `business_type`). These
 *      accumulate as the live extractor folds conversation facts into the V2
 *      model, so a fact stated earlier in the conversation counts on later
 *      turns regardless of phrasing/language.
 *   2. Verbatim recent customer utterances - immediate, same-turn. Anything the
 *      customer literally typed (emails, company names, channels, explicit
 *      terms) becomes part of the resolved-fact text the SAME turn it's said.
 *
 * Fail-soft: any error returns undefined (the ledger just falls back to the
 * CRM/memory snapshots, i.e. prior behavior).
 */
/**
 * Per-turn, language-aware resolution of the role's required-knowledge fields.
 *
 * Why this exists: the Knowledge Ledger + Objective Engine decide a field is
 * "known" by matching its English key/sourceHints (e.g. `business_type`,
 * `industry`) as substrings of the resolved-fact text. For a brand-new prospect
 * the structured/persisted layer is empty, so matching falls back to the
 * VERBATIM transcript - which is in the customer's language. A Hebrew answer
 * ("פלטפורמה לניהול מלאי") never contains the English token `business_type`, so
 * the field stayed permanently "missing" and the objective froze in GENERATE_LEAD
 * (observed live with omer: never reached BOOK_MEETING, looped, lost context).
 *
 * This reads the customer's messages in ANY language and returns the fields they
 * have actually provided, KEYED - emitted into the fact block so the ledger
 * matches on the literal key regardless of phrasing/language. Cheap model, JSON
 * output, fail-soft (any error → empty, i.e. prior behavior).
 */
async function resolveSessionKnowledge(opts: {
  tenantId: string;
  conversationId: string;
  fields: Array<{ key: string; label: string }>;
  inboundTexts: string[];
  signal?: AbortSignal;
}): Promise<Array<{ key: string; value: string }>> {
  if (!opts.fields.length || !opts.inboundTexts.length) return [];
  const fieldList = opts.fields.map((f) => `- ${f.key}: ${f.label}`).join("\n");
  const transcript = opts.inboundTexts.map((t) => `- "${t}"`).join("\n");
  try {
    const resp = await generateResponse({
      tenantId: opts.tenantId,
      sessionId: `${opts.conversationId}:knowledge-resolve`,
      model: getMicroModel(),
      temperature: 0,
      maxTokens: 400,
      responseFormat: { type: "json_object" },
      signal: opts.signal,
      metadata: { type: "ai_bot_knowledge_resolve", conversationId: opts.conversationId },
      messages: [
        {
          role: "system",
          content:
            "You read a customer's messages (in ANY language) and decide which of the listed facts they have ALREADY provided a concrete value for. " +
            'Return JSON exactly: {"facts":[{"key":"<one of the given field keys>","value":"<short English summary of what they said>"}]}. ' +
            "Include a field ONLY if the customer stated a real value for it - NOT if they merely asked about it, declined, or it is still unknown. " +
            "Use the EXACT field keys given; omit every field not yet provided. If none are provided, return {\"facts\":[]}.",
        },
        { role: "user", content: `Fields to look for:\n${fieldList}\n\nCustomer messages:\n${transcript}` },
      ],
    });
    const parsed = JSON.parse(resp.content || "{}");
    const validKeys = new Set(opts.fields.map((f) => f.key));
    const out: Array<{ key: string; value: string }> = [];
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
    for (const f of facts) {
      if (f && typeof f.key === "string" && validKeys.has(f.key) && f.value != null && String(f.value).trim()) {
        out.push({ key: f.key, value: String(f.value).trim().slice(0, 120) });
      }
    }
    return out;
  } catch (err: any) {
    if (isAbortError(err)) throw err;
    console.warn("[ai-bot] knowledge-resolve failed (fail-soft):", err?.message);
    return [];
  }
}

async function buildSessionFactsBlock(opts: {
  tenantId: string;
  conversationId: string;
  messages: Array<{ direction?: string; body?: string | null }>;
  /** Role's required-knowledge fields, for per-turn language-aware resolution. */
  knowledgeFields?: Array<{ key: string; label: string }>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const parts: string[] = [];

  // (1) Structured facts already extracted/persisted for this person.
  try {
    const identity = await resolveIdentity(opts.tenantId, opts.conversationId);
    if (identity) {
      const profile = await (prisma as any).customerProfile
        .findUnique({
          where: { tenantId_identityKey: { tenantId: opts.tenantId, identityKey: identity.identityKey } },
          select: { facts: true },
        })
        .catch(() => null);
      const facts = (profile?.facts ?? {}) as Record<string, { value?: unknown }>;
      const lines = Object.entries(facts)
        .filter(([, v]) => v && v.value != null && String(v.value).trim() !== "")
        .map(([k, v]) => `- ${k}: ${String(v.value).slice(0, 120)}`);
      if (lines.length) {
        parts.push(
          "## Facts already known about this customer (treat as established - do NOT re-ask)\n" +
            lines.join("\n"),
        );
      }
    }
  } catch {
    /* non-fatal - fall through to transcript layer */
  }

  // (2) Verbatim recent customer utterances (immediate, this session).
  const inboundMsgs = opts.messages
    .filter((m) => m.direction === "INBOUND" && !!m.body && !!m.body.trim())
    .slice(-12)
    .map((m) => (m.body as string).trim().slice(0, 200));
  if (inboundMsgs.length) {
    parts.push(
      "## What the customer said this conversation (verbatim - treat as known facts)\n" +
        inboundMsgs.map((t) => `- "${t}"`).join("\n"),
    );
  }

  // (3) Language-aware KEYED resolution of the role's required-knowledge fields.
  // Makes a Hebrew/any-language answer satisfy the (English-keyed) Knowledge
  // Ledger + Objective Engine so objectives actually progress. Fail-soft.
  if (opts.knowledgeFields?.length && inboundMsgs.length) {
    const resolved = await resolveSessionKnowledge({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      fields: opts.knowledgeFields,
      inboundTexts: inboundMsgs,
      signal: opts.signal,
    });
    if (resolved.length) {
      parts.push(
        "## Facts established this conversation (keyed - treat as known, do NOT re-ask)\n" +
          resolved.map((f) => `- ${f.key}: ${f.value}`).join("\n"),
      );
    }
  }

  return parts.length ? parts.join("\n\n") : undefined;
}

async function generateAIBotReplyInner(
  opts: {
    tenantId: string;
    conversationId: string;
    aiAgentId: string;
    incomingMessage: string;
    closedHours?: ClosedHoursContext;
    /** See generateAIBotReply - reaches the tool dispatcher only. */
    sandbox?: { enabled: true; writes: "safe" | "real" };
  },
  signal: AbortSignal,
): Promise<AIBotReplyResult> {
  const config = await prisma.aIAgent.findUnique({ where: { id: opts.aiAgentId } });
  if (!config || config.tenantId !== opts.tenantId) {
    throw Object.assign(new Error("AI Agent not found for tenant"), { status: 404 });
  }

  // Lifecycle enforcement (defense in depth behind the worker's dispatch
  // guard): a non-ACTIVE employee never answers customers. PAUSED/DRAFT
  // callers get a clean escalation result instead of a silent AI turn.
  // (The oneshot path is deliberately NOT guarded - escalation handoff /
  // bridge-ack messages must still render while an agent is paused.)
  if ((config as any).status !== "ACTIVE") {
    return {
      reply: null,
      escalation: {
        reason: `agent_inactive:${(config as any).status}`,
        priority: "low",
        summary: `AI employee is ${(config as any).status} - conversation needs a human.`,
      },
      awaitingApproval: null,
      toolCallLog: [],
      modelUsed: config.model || getDefaultModel(),
      totalTokens: 0,
    };
  }

  // Tenant default country - passed to extractIdentifierFromMessage so phone
  // candidates without a `+` prefix (e.g. Israeli "054-1234567" sent over IG)
  // still parse to E.164 and trigger identity_link against the existing CRM.
  const tenantRow = await prisma.tenant
    .findUnique({ where: { id: opts.tenantId }, select: { defaultCountryCode: true } })
    .catch(() => null);
  const tenantDefaultCountry = tenantRow?.defaultCountryCode || "IL";

  const conversation = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, tenantId: opts.tenantId },
  });
  if (!conversation) {
    throw Object.assign(new Error("Conversation not found"), { status: 404 });
  }

  // Per-turn / per-conversation / per-tenant-day token caps. Preflight
  // runs before any heavy lookups so a tripped cap aborts cheaply. The
  // budget enforcer is fail-open on DB errors - a transient UsageLog
  // hiccup never blocks live traffic, but the in-memory per-turn counter
  // still trips runaway loops below.
  const budget = createTurnBudget({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
  });
  try {
    await budget.preflight();
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      auditBudgetAbort({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        scope: err.scope,
        used: err.used,
        cap: err.cap,
        details: { stage: "preflight" },
      });
      return {
        reply: null,
        escalation: {
          reason: `budget_exceeded:${err.scope}`,
          priority: "low",
          summary: `Token budget exceeded (${err.scope}): ${err.used}/${err.cap}.`,
        },
        awaitingApproval: null,
        toolCallLog: [],
        modelUsed: config.model || getDefaultModel(),
        totalTokens: 0,
      };
    }
    throw err;
  }

  // Billing pre-flight: when the tenant cannot be served - no active plan, a
  // suspended account, or AI Units exhausted - and enforcement is in HARD mode,
  // escalate to a human cleanly instead of attempting an AI turn.
  // observe/soft/off never block here.
  const aiAllowance = await checkAiAllowed(opts.tenantId);
  if (!aiAllowance.allowed && aiAllowance.reason) {
    return {
      reply: null,
      escalation: {
        // Labelled by what actually happened. Calling a plan that was never
        // paid for "units_exhausted" sends an agent looking for a credit
        // balance that was never the problem.
        reason: `billing_blocked:${aiAllowance.reason}`,
        priority: "medium",
        summary: billingPauseSummary(aiAllowance),
      },
      awaitingApproval: null,
      toolCallLog: [],
      modelUsed: config.model || getDefaultModel(),
      totalTokens: 0,
    };
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

  // CRM prefetch - outputs:
  //   crmBlock for the prompt + crmHasLead/crmHasCustomer flags into BEL.
  let crmBlock: string | undefined;
  let crmHasLead = false;
  let crmHasCustomer = false;
  // Customer email resolved from CRM (or transcript) - feeds the calendar lookup
  // that lets reschedule/cancel find a meeting booked in an earlier conversation.
  let resolvedCustomerEmail: string | undefined;
  try {
    const recentEmail = extractRecentEmail(messages);
    resolvedCustomerEmail = recentEmail || undefined;
    const prefetch = await prefetchCrmContext(opts.tenantId, opts.conversationId, {
      externalId: conversation.customerExternalId,
      email: recentEmail,
    });
    if (prefetch) {
      crmBlock = renderCrmContextBlock(prefetch) || undefined;
      crmHasLead = prefetch.leadMatches.length > 0;
      resolvedCustomerEmail =
        prefetch.contactMatches.find((c) => c.email)?.email ||
        prefetch.leadMatches.find((c) => c.email)?.email ||
        resolvedCustomerEmail;
      crmHasCustomer = prefetch.contactMatches.some((c: any) => {
        const tags: string[] = (c?.tags || c?.lifecycle_stage_tags || []) as string[];
        return Array.isArray(tags) && tags.some((t) => /customer|active|paying/i.test(String(t)));
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] CRM prefetch failed (non-fatal):", err?.message);
  }

  // Identity lookups. Email + phone are fetched here so the
  // exit-criteria gate can verify `mustHaveFields` without a second
  // DB hit on every `close_conversation` dispatch.
  const contactRow = await prisma.contact.findFirst({
    where: { tenantId: opts.tenantId, channel: conversation.channel, externalId: conversation.customerExternalId },
    select: { id: true, email: true, phone: true },
  });
  if (!resolvedCustomerEmail && contactRow?.email) resolvedCustomerEmail = contactRow.email;
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

  // Tenant funnel (optional - Task 2). Pre-loaded so BEL stays pure.
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

  // GOAL PRESERVATION signal for the escalation gate: is the business objective
  // still viable this turn? We can reach the customer (contact captured or a CRM
  // record) AND they're actively engaged (their message triggered this turn).
  // When true, the soft autonomous-budget caps are suppressed so a hot, engaged
  // lead isn't handed to a human just for crossing a message/time counter. An
  // explicit human-handoff request is a SEPARATE flag and still escalates.
  const hasReachPath = !!(contactRow?.email || contactRow?.phone) || crmHasLead || crmHasCustomer;
  const customerEngaged =
    !!opts.incomingMessage?.trim() ||
    (messages.length > 0 && messages[messages.length - 1]?.direction === "INBOUND");
  // A scheduling request (book / move / cancel a meeting or demo) is an action
  // the AI can complete itself - it must NOT be handed to a human just for
  // crossing a counter. This is the #1 reason a RETURNING customer ("can we move
  // the demo?") used to escalate: their conversation is old, so the time cap
  // tripped. Treat such a turn as goal-viable.
  const schedulingIntentForGate =
    /(reschedul|postpone|\bmove\b|cancel|book|schedule|לקבוע|לתאם|להזיז|לדחות|לבטל|לשנות|פגיש|דמו|demo|meeting)/i.test(
      opts.incomingMessage || "",
    );
  const escalationGoalViable = (hasReachPath && customerEngaged) || schedulingIntentForGate;

  // Start of the CURRENT autonomous burst for the time-based escalation cap.
  // A burst is broken by a quiet gap (≥ BURST_RESET): a customer returning after
  // hours/days starts a fresh timer, so the "AI ran too long" cap measures the
  // active exchange, not the conversation's lifetime age (conversation.createdAt
  // would make every returning customer trip the cap instantly).
  const BURST_RESET_MS = 30 * 60_000;
  let autonomousSinceAt: Date = conversation.createdAt;
  for (let i = 1; i < messages.length; i++) {
    const prev = new Date(messages[i - 1].createdAt).getTime();
    const cur = new Date(messages[i].createdAt).getTime();
    if (cur - prev >= BURST_RESET_MS) autonomousSinceAt = new Date(messages[i].createdAt);
  }
  // If the newest stored message is itself stale (the current inbound arrives
  // after a long gap), the burst starts now.
  if (messages.length > 0) {
    const lastMs = new Date(messages[messages.length - 1].createdAt).getTime();
    if (Date.now() - lastMs >= BURST_RESET_MS) autonomousSinceAt = new Date();
  }

  // ── Behavior Engine - single decision point ─────────────
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
      // Last few inbound texts (oldest→newest) feed the trust/friction
      // signals - repeated-verification, repeated-complaint, and repetition
      // detection are inherently multi-message.
      recentInboundTexts: messages
        .filter((m) => m.direction === "INBOUND")
        .slice(-5)
        .map((m) => m.body || ""),
      lastAssistantMove,
      identifierMessage: extractIdentifierFromMessage(opts.incomingMessage, tenantDefaultCountry),
      assistantPreviouslyAskedFor: detectAssistantAskedFor(messages.map((m) => ({ direction: m.direction, body: m.body }))),
      previousAssistantText: [...messages].reverse().find((m) => m.direction === "OUTBOUND")?.body ?? undefined,
    },
    flags: {
      pendingApprovalsCount: pendingApprovals.length,
      humanHandoffRequested: detectHumanHandoff(opts.incomingMessage),
      escalationGateFired: await evaluateEscalationGates({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        config: {
          maxAutonomousMessages: config.maxAutonomousMessages,
          maxAutonomousMinutes: config.maxAutonomousMinutes,
        },
        autonomousSinceAt,
        goalViable: escalationGoalViable,
      }),
    },
    funnel,
    actionContracts,
    actionContractProgress,
  });

  // ── KB retrieval - strategy-controlled, NOT regex ──────
  let kbBlock: string | undefined;
  // Which sources actually fed this answer. Recorded for the sandbox's "why did
  // it answer this way?" panel: an operator debugging a wrong answer needs to
  // know whether the employee read the right document or retrieved nothing at
  // all, and guessing from the reply text is not good enough.
  const knowledgeUsed: Array<{ title: string; sourceType: string | null }> = [];
  if (shouldRetrieveKB(behaviorState, opts.incomingMessage)) {
    try {
      // Scoped to what THIS employee may read - see readableKnowledgeBaseIds.
      const chunks = await retrieveRelevantChunks(opts.tenantId, opts.incomingMessage, 5, opts.aiAgentId);
      kbBlock = buildKnowledgeContext(chunks) || undefined;
      for (const c of chunks as any[]) {
        const title = String(c?.documentTitle ?? c?.title ?? "").trim();
        if (title && !knowledgeUsed.some((k) => k.title === title)) {
          knowledgeUsed.push({ title, sourceType: c?.sourceType ?? null });
        }
      }
    } catch (err: any) {
      console.warn("[ai-bot] Knowledge retrieval failed:", err.message);
    }
  }

  // ── Conversation memory (Task 5) - fact snapshot injected as ground truth ─
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

  // ── Follow-up flow facts: WhatsApp 24h window + approved templates ──
  // The bot's follow-up decision tree (prompt-builder STRICT block) needs
  // these as ground truth so it can pick free-text vs template path
  // deterministically instead of guessing.
  const followupFacts = await loadFollowupFlowFacts({
    tenantId: opts.tenantId,
    conversation,
    locale: detectLocale(messages.map((m) => m.body || "")),
  });

  // ── Live-conversation facts (Objective Engine fix) ──────────────
  // The Knowledge Ledger + Objective Engine match against resolved-fact text.
  // Before this, that text was ONLY the CRM/memory/customer snapshots, so a
  // brand-new prospect who answered every question still read as knowing
  // nothing → objectives stuck forever (real WhatsApp regression). Feed in what
  // the customer ACTUALLY said this session so progression reflects reality.
  const sessionFactsBlock = await buildSessionFactsBlock({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    messages,
    knowledgeFields: requiredKnowledgeFor(config.role),
    signal,
  });

  // ── Build system prompt ────────────────────────────────
  const ctxSlot: ContextSlot = {
    customerBlock: renderCustomerInfoBlock(conversation, {
      email: resolvedCustomerEmail,
    }),
    crmBlock,
    memoryBlock,
    pendingApprovalsBlock: renderPendingApprovalsBlock(pendingApprovals),
    whatsappWindowBlock: followupFacts.whatsappWindowBlock,
    templatesBlock: followupFacts.templatesBlock,
    sessionFactsBlock,
  };

  // ── Grammatical address ────────────────────────────────
  //
  // In Hebrew the reply has to pick a form for almost every verb aimed at
  // the customer. This resolves which one from what the customer wrote
  // about THEMSELVES in this conversation - a first-person agreement form
  // or an outright request - and nothing else. Their name, phone, email
  // and purchase history are not inputs and there is no code path that
  // could make them inputs. See packages/shared/src/lib/grammatical-address.ts.
  const addressLocale = detectLocale(messages.map((m) => m.body || ""));
  const storedAddress = readGrammaticalAddress((conversation as any).grammaticalAddress);
  const newestInbound = [...messages].reverse().find((m) => m.direction === "INBOUND");
  const addressUpdate = updateGrammaticalAddress({
    current: storedAddress,
    // The live inbound when the caller passed one (it may not be persisted
    // yet), otherwise the newest inbound row.
    text: opts.incomingMessage?.trim() || newestInbound?.body || "",
    messageId: newestInbound?.id,
    locale: addressLocale,
  });
  if (addressUpdate.changed) {
    // Fire and forget: a form we failed to persist costs one turn of
    // staleness, and blocking a customer reply on it would be worse.
    prisma.conversation
      .update({
        where: { id: opts.conversationId },
        data: { grammaticalAddress: addressUpdate.next as any },
      })
      .catch((err: any) =>
        console.warn("[ai-bot] grammatical address persist failed:", err?.message),
      );
  }
  // `language` is stamped for the PROMPT even when the form is unknown, so
  // a Hebrew conversation with no evidence still gets the neutral-phrasing
  // instruction instead of silence. Only `addressUpdate.next` is persisted.
  ctxSlot.grammaticalAddress = {
    ...addressUpdate.next,
    language: addressUpdate.next.language ?? addressLocale,
  };

  // Verified commerce context for the AI employee (spec §7): only when Shopify
  // is the elected Source of Truth AND the conversation's customer is
  // verified-linked. Cached (60s), stripped of admin URLs / refundable-max /
  // internal LTV, and carries hard usage guardrails. Never blocks the turn.
  if (process.env.COMMERCE_AI_SNAPSHOT !== "off") {
    try {
      const commerceSnap = await buildAICommerceSnapshot({
        tenantId: opts.tenantId,
        conversationId: conversation.id,
      });
      if (commerceSnap) {
        const snapLocale: "he" | "en" =
          String((conversation as any).detectedLocale || "").toLowerCase().startsWith("he") ? "he" : "en";
        const commerceBlock = formatCommerceSnapshotForPrompt(commerceSnap, snapLocale);
        ctxSlot.crmBlock = ctxSlot.crmBlock ? `${ctxSlot.crmBlock}\n\n${commerceBlock}` : commerceBlock;
      }
    } catch {
      /* commerce snapshot is best-effort context; never fail the reply on it */
    }
  }

  // ── Tool surface - single source of truth: state.allowedActions ──
  // Build it BEFORE the prompt so we can pass the actual function names
  // into the Execution Contract's capability whitelist.
  // Single calendar-capability signal (NO_CALENDAR / CALENDAR_CONNECTED /
  // CALENDAR_CONNECTED_AND_BOOKABLE). schedule_meeting is surfaced ONLY when
  // bookable; the same signal feeds the prompt fail-safe + output validator so
  // a non-bookable agent can never agree to a time.
  const calendarCapability: CalendarCapabilityDetail = await computeCalendarCapability(
    opts.tenantId,
    config.id,
  );
  const hasConnectedCalendar = calendarCapability.bookable;
  // A meeting already booked in THIS conversation (from the audit trail). Drives
  // BOTH whether reschedule/cancel are surfaced AND a prompt fact so the model
  // moves/cancels the real event instead of calling schedule_meeting again
  // (which would create a duplicate). Only meaningful when bookable.
  // Cheap intent check on the latest inbound: only pay for the cross-conversation
  // calendar lookup (a Google API call) when the customer actually mentions
  // moving/cancelling an existing meeting. Normal turns use only the cheap
  // in-conversation audit path. The handlers themselves always do the full
  // resolve (by then the model has already chosen to reschedule/cancel).
  const latestInbound =
    (opts.incomingMessage?.trim() ||
      (messages.length > 0 && messages[messages.length - 1]?.direction === "INBOUND"
        ? messages[messages.length - 1]?.body
        : "")) ?? "";
  const wantsMeetingChange =
    /(reschedul|postpone|move\b|cancel|לבטל|להזיז|לדחות|לשנות|כבר קבעתי|כבר יש לי פגיש)/i.test(latestInbound);
  const existingBooking: ActiveBooking | null = hasConnectedCalendar
    ? await resolveActiveBooking({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        aiAgentId: config.id,
        customerExternalId: conversation.customerExternalId ?? undefined,
        customerEmail: wantsMeetingChange ? resolvedCustomerEmail : undefined,
      })
    : null;
  const hasExistingBooking = !!existingBooking;
  // Company identity inherited from the tenant BusinessProfile - so the agent
  // always knows who it works for and what the company does/sells.
  const companyContext: CompanyContext | null = await getCompanyContext(opts.tenantId);
  // Shopify Live Chat wiring. Null on every other channel, which is the
  // common case — the storefront block and the product tools simply do
  // not exist for a WhatsApp or Instagram turn.
  const shopifyTurn = await prepareShopifyTurn({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
  }).catch((err: any) => {
    console.warn("[ai-bot] shopify turn prep failed:", err?.message);
    return null;
  });
  if (shopifyTurn?.storefrontBlock) {
    ctxSlot.storefrontBlock = shopifyTurn.storefrontBlock;
  }
  // Set later in the turn, read by runAdapterTool's gate below. Declared here
  // because the tool context closes over it and is built before the controller
  // runs; the closure reads it at call time, by which point it is resolved.
  let resolvedFlow: FlowDecision | null = null;

  // The order the conversation is already about. The controller uses it only
  // when the customer names none, and never to override one they did.
  const anchoredOrderName = ((): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const named = orderNameFromMessage(messages[i]?.body ?? "");
      if (named) return named;
    }
    return null;
  })();

  const agentToolCtx: AgentToolContext = {
    sendShopifyProducts: shopifyTurn?.sendShopifyProducts,
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    contactId: contactRow?.id,
    authToken: process.env.INTERNAL_SERVICE_TOKEN,
    // "Test the AI Employee" runs this exact function, so the sandbox flag has
    // to reach the dispatcher. Everything else about the turn stays identical -
    // same prompt, same tools offered, same policy gate - and only the moment
    // of execution differs for mutating tools. Absent for live traffic.
    sandbox: opts.sandbox,
    scheduleMeeting: hasConnectedCalendar
      ? makeScheduleMeetingHandler({
          tenantId: opts.tenantId,
          aiAgentId: config.id,
          conversationId: opts.conversationId,
          customerExternalId: conversation.customerExternalId ?? undefined,
          customerEmail: resolvedCustomerEmail,
        })
      : undefined,
    // Read-only availability lookup - surfaced together with schedule_meeting so
    // the bot answers "what's free / what are your hours?" from the calendar and
    // never invents times.
    checkAvailability: hasConnectedCalendar
      ? makeCheckAvailabilityHandler({
          tenantId: opts.tenantId,
          aiAgentId: config.id,
          conversationId: opts.conversationId,
          customerExternalId: conversation.customerExternalId ?? undefined,
          customerEmail: resolvedCustomerEmail,
        })
      : undefined,
    rescheduleMeeting: hasExistingBooking
      ? makeRescheduleMeetingHandler({
          tenantId: opts.tenantId,
          aiAgentId: config.id,
          conversationId: opts.conversationId,
          customerExternalId: conversation.customerExternalId ?? undefined,
          customerEmail: resolvedCustomerEmail,
        })
      : undefined,
    cancelMeeting: hasExistingBooking
      ? makeCancelMeetingHandler({
          tenantId: opts.tenantId,
          aiAgentId: config.id,
          conversationId: opts.conversationId,
          customerExternalId: conversation.customerExternalId ?? undefined,
          customerEmail: resolvedCustomerEmail,
        })
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
    runCreateTask: async ({ subject, body, priority }) => {
      // Route create_task through the existing action-executor path so it
      // hits the same CRM connector (Zoho/HubSpot/…) and audit log as the
      // post-chat pipeline. contactId is required by the executor - fall
      // back to a per-tenant policy result when the local contact row
      // isn't resolved yet (rare; identity-link normally runs first).
      if (!contactRow?.id) {
        return { ok: false, reason: "no_contact_for_task" };
      }
      const action: PlannedAction = {
        tool: "create_task",
        params: { contactId: contactRow.id, subject, body, priority: priority || "normal" },
        reason: "ai_bot:create_task",
        riskLevel: "low",
      };
      const r = await executeAction(opts.tenantId, action, {
        actorId: `ai_bot:${opts.conversationId}`,
      });
      if (r.ok) return { ok: true, result: r.output ?? r };
      return { ok: false, reason: r.skipReason || r.error || "create_task_failed" };
    },
    runCreateLead: async ({ kind, name, email, phone, company, notes }) => {
      // Vendor-neutral create: resolve the tenant's source-of-truth CRM and let
      // its adapter map fields. Works uniformly for HubSpot/Salesforce/Zoho/
      // Airtable/Fireberry/Shopify; a tenant with no real CRM gets a stub
      // adapter and a clean `no_crm_configured` the bot can pivot from.
      try {
        const adapter = await getCrmAdapter(opts.tenantId);
        if (adapter.capabilities.is_stub) {
          return { ok: false, reason: "no_crm_configured" };
        }
        const r = await adapter.createLead({
          display_name: name,
          email,
          phone,
          company,
          source: "ai_bot",
          custom: notes ? { notes } : undefined,
        });
        if (r.ok) {
          // The new row changes what crm-prefetch returns next turn; drop the
          // cache so the dedup strip sees the customer as existing and switches
          // the bot to update/note tools.
          try { invalidateCrmPrefetch(opts.tenantId, opts.conversationId); } catch { /* non-fatal */ }
          return { ok: true, id: r.id, kind: r.kind, vendor: adapter.vendor };
        }
        return { ok: false, reason: r.reason || "create_lead_failed" };
      } catch (err: any) {
        console.warn("[ai-bot] runCreateLead failed:", err?.message);
        return { ok: false, reason: err?.message || "create_lead_failed" };
      }
    },
    requestIdentityVerification: async ({ phone, email }) => {
      // The typed phone/email is UNTRUSTED - it only locates the stored
      // account. This lookup runs with INTERNAL scope on the server and its
      // result is never handed to the model; the OTP goes exclusively to the
      // destination stored on that account, and the model gets a masked echo.
      try {
        const lookup = phone
          ? await executeAdapterTool({
              tenantId: opts.tenantId,
              toolFunctionName: "shopify.get_customer_by_phone",
              args: { phone },
            })
          : email
            ? await executeAdapterTool({
                tenantId: opts.tenantId,
                toolFunctionName: "shopify.get_customer_by_email",
                args: { email },
              })
            : null;
        const target: any = lookup && lookup.ok ? (lookup as any).result : null;
        if (!target?.id) {
          // Do not reveal whether the account exists.
          return { ok: false, reason: "verification_unavailable_for_that_identity" };
        }
        const { issueCustomerVerification } = await import("@chatcenter/shared");
        const issued = await issueCustomerVerification({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          target: { customerId: String(target.id), phone: target.phone, email: target.email },
        });
        if (!issued.ok) return { ok: false, reason: issued.reason };
        return { ok: true, sent_to: issued.sentToMasked };
      } catch (err: any) {
        console.warn("[ai-bot] identity verification issue failed:", err?.message);
        return { ok: false, reason: "verification_failed" };
      }
    },
    submitVerificationCode: async ({ code }) => {
      try {
        const { confirmCustomerVerification } = await import("@chatcenter/shared");
        return await confirmCustomerVerification({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          code,
        });
      } catch (err: any) {
        console.warn("[ai-bot] verification confirm failed:", err?.message);
        return { ok: false, reason: "verification_failed" };
      }
    },
    runAdapterTool: async ({ toolFunctionName, args }) => {
      // ── Resolved-flow gate ───────────────────────────────────────────
      // The flow controller decided this turn's move from verified facts. This
      // is what makes that decision binding rather than advisory: a critical
      // tool called with arguments the controller did not compute is refused.
      // That is the shape of every expensive mistake in Parts 1-5 - an approval
      // raised for an exchange with no variant in it, a refund against a stale
      // order, a lookup of a product the model guessed the name of.
      {
        const verdict = assertMatchesResolvedFlow(resolvedFlow, toolFunctionName, args as Record<string, any>);
        if (!verdict.ok) {
          console.warn(`[ai-bot][flow] refused ${toolFunctionName}: ${verdict.reason}`);
          return { ok: false as const, reason: verdict.reason };
        }
      }
      // ── Order anchoring fence ────────────────────────────────────────
      // A model carrying a long history can walk a STALE order into a refund.
      // Live: after a failed refund on #1006 the customer wrote "לא, שכח
      // מ1006 ... ההזמנה מספר 1010 בלבד" and the bot kept acting on #1006
      // through both the negation and the re-selection.
      //
      // This does not guess. It only refuses when the customer's own latest
      // message contradicts the target - a number they excluded, or a
      // different order they just named. A message naming no order constrains
      // nothing, and reads are never fenced.
      if (isOrderStateChangingTool(toolFunctionName)) {
        const verdict = assertOrderTargetMatchesTurn({
          message: opts.incomingMessage ?? "",
          args: args as Record<string, unknown>,
          isStateChanging: true,
        });
        if (!verdict.ok) {
          console.warn(
            `[ai-bot] order fence blocked ${toolFunctionName} on ${verdict.got} ` +
              `(customer named ${JSON.stringify(verdict.expected)})`,
          );
          return { ok: false as const, reason: `wrong_order: ${verdict.reason}` };
        }
      }
      const result = await executeAdapterTool({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        contactId: contactRow?.id,
        toolFunctionName,
        args,
        // The LLM is acting FOR the customer channel here - protected
        // customer/order tools are authorized against the conversation's
        // authenticated sender identity (P0 cross-customer guard). Typed
        // phones/emails/order numbers in chat can never widen this.
        accessScope: "customer",
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
    // Read-only availability lookup rides on the same bookable-calendar signal.
    checkAvailability: hasConnectedCalendar,
    // Surface move/cancel ONLY when an actual booking exists in this conversation,
    // so the model can't try to move/cancel a meeting that was never made.
    rescheduleMeeting: hasExistingBooking,
    cancelMeeting: hasExistingBooking,
    // Honor CatalogTool.allowedModes - tools tagged ASSIST-only are dropped
    shopifyProducts: shopifyTurn?.productMessagingEnabled === true,
    // Honor CatalogTool.allowedModes — tools tagged ASSIST-only are dropped
    // from the autonomous surface. The copilot path uses {closure,followup}
    // flags; the autonomous path uses this mode filter.
    allowedMode: "AUTO",
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

  // Snapshot of what the model was actually offered, for diagnostics.
  const toolsOffered: string[] = (tools as any[])
    .map((t) => t?.function?.name)
    .filter((n): n is string => typeof n === "string");

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
    // Governance set for adapter tools. Key: `${integrationSlug}:${catalogToolSlug}`.
    // Built from the SAME guest-list the governed `integration_<slug>` path uses
    // (AgentToolPermission.isAllowed + TenantTool.isEnabled + CONNECTED +
    // allowedModes), so the autonomous bot never surfaces an adapter tool the
    // operator hasn't enabled for THIS agent. Without this, every tool of every
    // connected integration would leak in regardless of the marketplace toggle.
    const allowedAdapterTools = new Set<string>();
    try {
      const perms = await prisma.agentToolPermission.findMany({
        where: {
          tenantId: opts.tenantId,
          aiAgentId: config.id,
          isAllowed: true,
          tenantTool: { isEnabled: true, tenantIntegration: { status: "CONNECTED" } },
        },
        include: {
          tenantTool: {
            include: {
              catalogTool: { select: { slug: true, allowedModes: true } },
              tenantIntegration: { include: { integration: { select: { slug: true } } } },
            },
          },
        },
      });
      for (const p of perms as any[]) {
        const tt = p.tenantTool;
        const integSlug = tt?.tenantIntegration?.integration?.slug;
        const toolSlug = tt?.catalogTool?.slug;
        if (!integSlug || !toolSlug) continue;
        // AUTO surface: drop ASSIST-only tools. allowedModes default permits all,
        // so a missing/malformed value is treated as "allowed".
        const am = tt?.catalogTool?.allowedModes;
        if (Array.isArray(am) && !am.includes("AUTO")) continue;
        allowedAdapterTools.add(`${integSlug}:${toolSlug}`);
      }
    } catch (err: any) {
      console.warn("[ai-bot] adapter tool permission load failed:", err?.message);
    }

    // Slugs whose adapter tools accept a `table`/`collection` arg and benefit
    // from a tenant-curated table list with per-table notes appended to the
    // tool description (so the AI knows what each table is and when to use it).
    const DB_SLUGS = new Set(["postgresql", "mongodb", "aws_rds"]);
    for (const adapter of listAdapters()) {
      // Adapter slug IS the catalog slug. A translation map used to live here
      // for postgres/postgresql, which papered over the mismatch on the tool
      // SURFACE while executeAdapterTool - which has no such map - still failed
      // every call with not_connected. The adapter was renamed instead.
      const catalogSlug = adapter.slug;
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
              if (n.description) parts.push(`- ${n.description}`);
              if (n.whenToUse) parts.push(`[USE WHEN: ${n.whenToUse}]`);
              return parts.join(" ");
            }).join("\n")
          : "";
      // Capability freshness: the surface is built from VERIFIED capabilities.
      // If this connection's capability snapshot is stale (or was never
      // taken - pre-existing connections), re-probe in the background so the
      // next turn gates on current provider truth instead of data that could
      // have drifted since connect. Non-blocking on purpose: this turn still
      // uses the last KNOWN state, which the OAuth-callback probe seeds at
      // connect time for new stores.
      if (typeof adapter.validate === "function" && !capabilityStateIsFresh(cfg)) {
        void refreshCapabilityState({
          tenantId: opts.tenantId,
          slug: catalogSlug,
        }).catch((err: any) =>
          console.warn(`[ai-bot] capability refresh failed for ${catalogSlug}:`, err?.message));
      }
      for (const def of adapter.tools()) {
        // Governance gate (parity with the governed `integration_<slug>` path):
        // surface this tool ONLY if it is enabled for the tenant AND allowed for
        // THIS agent. `def.name` is `<provider>.<toolSlug>`; the catalog tool
        // slug is the part after the dot.
        const toolSlug = def.name.includes(".") ? def.name.slice(def.name.indexOf(".") + 1) : def.name;
        if (!allowedAdapterTools.has(`${catalogSlug}:${toolSlug}`)) continue;
        // Capability gate: never offer a tool the shop cannot execute. When a
        // provider proved a scope missing ("requires merchant approval"), the
        // framework persists it on config.missingScopes - offering the tool
        // anyway would let the model open an approval that can never run
        // (exactly the Matan coupon HITL). State self-heals on re-connect or
        // a passing integration test.
        if (toolBlockedByMissingScopes(def, missingScopesFromConfig(cfg))) continue;
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

  // ── Unified semantic lead/contact creation ──
  // Collapse every vendor's raw create path (adapter `<slug>.create_record` /
  // `create_lead` / `create_contact` / `create_item`, and the auto-surfaced
  // governed `integration_create_*` catalog tools) into ONE vendor-neutral pair
  // routed through the resolved CRMAdapter. This gives Airtable/Fireberry/etc.
  // the same lead-creation UX as HubSpot and guarantees correct per-vendor field
  // mapping. Governance is preserved: we only surface the semantic tools when a
  // raw create path WAS already enabled for the resolved source-of-truth CRM, so
  // an operator who never enabled "create" still gets no create tool.
  try {
    const adapter = await getCrmAdapter(opts.tenantId);
    if (!adapter.capabilities.is_stub) {
      const VENDOR_TO_SLUG: Record<CrmVendor, string> = {
        hubspot: "hubspot", salesforce: "salesforce", zoho: "zoho_crm", shopify: "shopify",
        fireberry: "fireberry", airtable: "airtable", pipedrive: "pipedrive", monday: "monday",
        custom_api: "custom_api", custom_db: "custom_db",
      };
      const slug = VENDOR_TO_SLUG[adapter.vendor] ?? adapter.vendor;
      const isRawCreate = (n: string): boolean =>
        n === `${slug}.create_record` || n === `${slug}.create_lead` ||
        n === `${slug}.create_contact` || n === `${slug}.create_item` ||
        n === "integration_create_lead" || n === "integration_create_contact" ||
        n === "integration_create_record";
      const hadRawCreate = (tools as any[]).some((t) => isRawCreate(t?.function?.name || ""));
      if (hadRawCreate) {
        tools = (tools as any[]).filter((t) => !isRawCreate(t?.function?.name || ""));
        tools.push(INTEGRATION_CREATE_LEAD_TOOL, INTEGRATION_CREATE_CONTACT_TOOL);
      }
    }
  } catch (err: any) {
    console.warn("[ai-bot] unified CRM create-tool surface failed:", err?.message);
  }

  // Surface-level CRM strip - when crm-prefetch finds an existing lead or
  // contact, the prompt builder injects a note telling the LLM that
  // create_lead/create_contact have been removed. That note is necessary
  // but not sufficient: a confused LLM can still emit the tool call and
  // duplicate the CRM record. Belt-and-braces - actually drop the tool
  // from the array so the model literally cannot select it.
  if (crmHasLead) {
    tools = (tools as any[]).filter((t) => {
      const n = t?.function?.name || "";
      return !/^(?:integration_)?create_lead\b/.test(n);
    });
  }
  if (crmHasCustomer) {
    tools = (tools as any[]).filter((t) => {
      const n = t?.function?.name || "";
      return !/^(?:integration_)?create_contact\b/.test(n);
    });
  }

  // SINGLE filter - replaces the legacy stripCreateLead/Contact + pendingApprovals filters.
  tools = filterToolsByAllowedActions(tools, behaviorState);

  // Diagnostic: surfaced scheduling tools + contract-gate state, so a missing
  // reschedule/cancel is observable instead of inferred.
  console.log(
    `[ai-bot][tool-surface] convo=${opts.conversationId} strategy=${behaviorState.strategy} ` +
      `hasExistingBooking=${hasExistingBooking} ` +
      `checkavail=${tools.some((t: any) => t?.function?.name === "check_availability")} ` +
      `sched=${tools.some((t: any) => t?.function?.name === "schedule_meeting")} ` +
      `resched=${tools.some((t: any) => t?.function?.name === "reschedule_meeting")} ` +
      `cancel=${tools.some((t: any) => t?.function?.name === "cancel_meeting")} ` +
      `contractActive=${behaviorState.actionContractState?.active ?? false} ` +
      `contractBlocking=${behaviorState.actionContractState?.blocking ?? false} ` +
      `pending=[${(behaviorState.actionContractState?.pendingTools ?? []).join(",")}]`,
  );

  // Sort tools alphabetically by function name BEFORE the OpenAI call so the
  // `tools` array is byte-stable across turns of the same conversation.
  // The model picks tools by name; array order doesn't influence its choice,
  // so this is purely a cache-prefix-stability optimization with zero
  // behavioral effect. Required because the upstream assemble path
  // (built-in + adapter + integration tools) doesn't guarantee a deterministic
  // order, and OpenAI's prefix cache is byte-sensitive on the entire request.
  tools = (tools as any[]).slice().sort((a, b) => {
    const an = a?.function?.name ?? "";
    const bn = b?.function?.name ?? "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  // Policy pre-filter - make the SURFACE agree with the DISPATCH gate.
  // Dispatch runs every tool call through evaluatePolicies() (via the
  // orchestrator). If a tool is surfaced but evaluatePolicies would hard-DENY
  // it (no tenant tool / not granted to this agent / disabled / unknown custom
  // tool), then offering it only wastes a full prompt+tools LLM round: the model
  // picks it, the gate rejects it, and we loop. Dropping such tools up front
  // costs nothing in capability (a DENY tool was never dispatchable) and removes
  // the wasted round. REQUIRE_APPROVAL tools are KEPT - they are valid and route
  // through HITL. Args aren't known yet, but DENY decisions are args-independent.
  // Runs once per turn, in parallel; fail-soft (a check error keeps the tool).
  try {
    const decisions = await Promise.all(
      (tools as any[]).map(async (t) => {
        const name = t?.function?.name;
        if (typeof name !== "string" || !name) return { keep: true, name };
        try {
          const r = await evaluatePolicies({ tenantId: opts.tenantId, toolName: name, aiAgentId: config.id });
          return { keep: r.decision !== "DENY", name, reason: r.reason };
        } catch {
          return { keep: true, name };
        }
      }),
    );
    const dropped = decisions.filter((d) => !d.keep);
    if (dropped.length) {
      console.warn(
        `[ai-bot] surface/policy disagreement - dropped ${dropped.length} tool(s) the dispatch gate would deny: ` +
          dropped.map((d) => `${d.name} (${d.reason})`).join("; "),
      );
      const keepNames = new Set(decisions.filter((d) => d.keep).map((d) => d.name));
      tools = (tools as any[]).filter((t) => keepNames.has(t?.function?.name));
    }
  } catch (err: any) {
    console.warn("[ai-bot] policy pre-filter failed (keeping full surface):", err?.message);
  }

  // ── Hard cap: OpenAI rejects a tools array longer than 128 ──
  //
  // Not a soft limit. The API answers 400 "Invalid 'tools': array too long"
  // and the ENTIRE request fails - no reply, no tool calls, nothing. The turn
  // then falls back to a tool-less generation, and a model with no tools can
  // only apologise or hand the conversation to a human.
  //
  // That is exactly what a merchant saw on 2026-07-31: 62 enabled Shopify
  // tools plus the built-ins came to 131, every turn 400'd, and a customer
  // asking to cancel an order was told "אני מעבירה את הבקשה לצוות אנושי" -
  // I'm passing this to a human team - three times in a row. The approval
  // flow, the permissions and the tool itself were all fine; the request never
  // reached the model.
  //
  // Built-ins are kept whole: escalation, identity linking and scheduling are
  // the agent's own faculties, and dropping `escalate_to_human` to make room
  // for a catalog read would be the worst possible trade.
  //
  // Integration tools are dropped LOWEST-PRIORITY first (see
  // ToolDefinition.priority), with the alphabetical order kept only as the
  // tie-break so the choice stays deterministic. Truncating alphabetically
  // alone cut whatever happened to sort last, which on the Urban Supply store
  // meant `shopify.variant_information` and `shopify.validate_discount` - so
  // "do you have it in a 159?" and "is this coupon valid?" both had no tool
  // behind them while dozens of rarely-used tools survived on the strength of
  // their first letter.
  //
  // Logged at ERROR because a silently smaller surface is a capability the
  // merchant thinks they have and does not: the fix is for them to disable
  // tools they do not use, and they cannot do that if nobody tells them.
  const OPENAI_MAX_TOOLS = 128;
  if ((tools as any[]).length > OPENAI_MAX_TOOLS) {
    const nameOf = (x: any): string => x?.function?.name ?? "";
    const isIntegration = (n: string) => n.includes(".") || n.startsWith("integration.");
    const builtIns = (tools as any[]).filter((x) => !isIntegration(nameOf(x)));
    const integrations = (tools as any[])
      .filter((x) => isIntegration(nameOf(x)))
      .sort((a: any, b: any) => {
        const pa = getToolPriority(nameOf(a)), pb = getToolPriority(nameOf(b));
        if (pa !== pb) return pb - pa; // highest priority survives
        const an = nameOf(a), bn = nameOf(b);
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    const room = Math.max(0, OPENAI_MAX_TOOLS - builtIns.length);
    const dropped = integrations.slice(room);
    if (dropped.length) {
      console.error(
        `[ai-bot] tool surface ${(tools as any[]).length} exceeds OpenAI's ${OPENAI_MAX_TOOLS}-tool limit ` +
          `for tenant=${opts.tenantId} agent=${config.id}. Dropping ${dropped.length} integration tool(s) ` +
          `so the request does not fail outright: ${dropped.map(nameOf).join(", ")}. ` +
          `Disable unused tools for this agent to choose what is lost.`,
      );
    }
    tools = [...builtIns, ...integrations.slice(0, room)].sort((a: any, b: any) => {
      const an = nameOf(a), bn = nameOf(b);
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
  }

  let toolFunctionNames: string[] = (tools as any[])
    .map((t) => t?.function?.name)
    .filter((n): n is string => typeof n === "string");

  // ── Pipeline stage resolution ──────────────────────────────
  // The same stage-resolver the voice copilot uses - pulls the customer's
  // current funnel stage from CRM, falls back to the funnel's first stage
  // for new contacts, or returns null when no funnel is configured. The
  // chat bot now follows the funnel exactly the way call-pilot does:
  // stage.goal / requiredQuestions / requiredDataFields / exitCriteria
  // all flow into the per-turn prompt block. Fail-soft - any error here
  // just means the bot falls back to the agent-level config.
  let stageContext: StageContextForPrompt | undefined;
  try {
    const resolved = await resolveActiveStage({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      departmentId: conversation.departmentId ?? null,
    });
    if (resolved) {
      stageContext = {
        id: resolved.stage.id,
        label: resolved.stage.label,
        nextLabel: resolved.nextStage?.label ?? null,
        copilot: resolved.stage.copilot,
      };
    }
  } catch (err: any) {
    console.warn("[ai-bot] stage resolution failed (non-fatal):", err?.message);
  }

  // CRM presence flags → Prospect State + Objective Engine. `crmBlock` is set
  // only when the external CRM returned a record, so its absence is the
  // authoritative "NEW_PROSPECT" signal (internal Contact rows don't count).
  const crmFlags = {
    hasLead: crmHasLead,
    hasContact: !!crmBlock || crmHasLead || crmHasCustomer,
    isCustomer: crmHasCustomer,
  };

  // SHARED BRAIN: assemble the per-turn plan context ONCE. The AI Employee (here)
  // and the AI Copilot both call assemblePlanContext, so the objective engine sees
  // identical inputs → an identical Current Plan. Execution mode is the only
  // difference (the Employee acts; the Copilot recommends). See plan-context.service.
  const planContext = await assemblePlanContext({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    role: config.role,
    agentId: config.id,
    goal: (config as any).goal ?? null,
    salesContext: config.salesContext,
    customer: { channel: conversation.channel, externalId: conversation.customerExternalId },
    crmFlags,
    contextBlocks: {
      customerBlock: ctxSlot.customerBlock,
      crmBlock: ctxSlot.crmBlock,
      memoryBlock: ctxSlot.memoryBlock,
      sessionFactsBlock: ctxSlot.sessionFactsBlock,
    },
    messages,
    signal,
  });
  const committedActionTools = planContext.completedActionTools;
  const priorGoal = planContext.priorGoal;
  const wizardFacts = planContext.wizardFacts;
  const toolCapabilityHints = planContext.toolCapabilityHints;

  // OUTCOME QUALITY > DATA COLLECTION (role-agnostic): don't let the model create
  // records (lead/contact/deal/opportunity/ticket/case/…) unless creation is
  // meaningful progress. Generic rules, no per-role logic: (a) a poor-fit prospect
  // gets NO records created; (b) a high-commitment object (deal/opportunity/quote/
  // order) requires a real, known contact to attach to (prospectState ≠ NEW) -
  // you don't open a deal for an anonymous/hostile/unqualified contact. Capture
  // objects (lead/contact/ticket) stay available for genuinely engaged prospects.
  // Filtering the SURFACE is the single choke point: the model cannot call an
  // un-surfaced tool in ANY loop (main / preference / recovery / regen).
  const prospectStateForGate = computeProspectState(crmFlags);
  tools = filterCreationToolsByEngagement(tools as any[], {
    fit: wizardFacts.fit,
    prospectState: prospectStateForGate,
  });
  toolFunctionNames = (tools as any[])
    .map((t) => t?.function?.name)
    .filter((n): n is string => typeof n === "string");

  const promptOpts: BuildPromptOpts = {
    behaviorState,
    agent: toAgentRecord(config),
    context: ctxSlot,
    knowledge: { block: kbBlock },
    toolFunctionNames,
    toolCapabilityHints,
    hasActiveBooking: hasExistingBooking,
    stageContext,
    crm: crmFlags,
    calendarBookable: calendarCapability.bookable,
    completedActionTools: committedActionTools,
    priorGoal,
    wizardFacts,
    company: companyContext ?? undefined,
  };
  const systemPrompt = buildAgentPrompt(promptOpts);

  // ── Per-turn correlation. shadowTurnId is minted every turn (so the legacy audit
  //    carries a join key regardless).
  const shadowTurnId = randomUUID();
  // Compute the SAME CurrentPlan the prompt rendered, once, when the reasoner-shadow
  // is engaged - it feeds the Planner↔Reasoner decision comparison below.
  const runtimePlan = isAgentArchitectureEnabled()
    ? (() => { try { return computeCurrentPlanForOpts(promptOpts); } catch { return null; } })()
    : null;

  // Reasoner shadow (Agent architecture, Phase 3): compare the Planner's decision
  // to the Reasoner's over the SAME Oracle Facts and persist an eval-corpus row.
  // Dark + fire-and-forget: gated by AGENT_ARCHITECTURE_ENABLED, fully try/caught
  // - it can NEVER affect this turn (the Planner drives; the Reasoner never acts).
  try {
    runShadowEvaluationInBackground(
      toShadowContext({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        turnId: shadowTurnId,
        sessionId: opts.conversationId,
        bestNextAction: (runtimePlan?.bestNextAction as any) ?? null,
        prospectFlags: (promptOpts as any).prospectFlags,
        toolFunctionNames: (promptOpts as any).toolFunctionNames,
        calendarBookable: (promptOpts as any).calendarBookable,
        hasActiveBooking: !!(promptOpts as any).hasActiveBooking,
        transcript: messages
          .filter((m: any) => m.body?.trim())
          .map((m: any) => ({ role: m.direction === "INBOUND" ? ("customer" as const) : ("agent" as const), text: m.body as string })),
        goalOutcome: runtimePlan?.goal ?? undefined,
      }),
    );
  } catch { /* shadow must never break the turn */ }

  const chatMessages: any[] = [{ role: "system", content: systemPrompt }];

  // ── Discovery State (structured conversational memory) ──────────────────
  // Extract shopping facts into the authoritative per-conversation session,
  // inject a compact snapshot into BLOCK 5 (so answered questions are never
  // re-asked), and decide the next action deterministically. When ready + the
  // real product tool is offered, force the search this turn; when ready but
  // the tool is absent, steer to an honest handoff instead of a fake search.
  let discoveryForceTool: string | null = null;
  // Canonical typed product envelope for this turn (set when a Shopify product
  // search runs); drives deterministic grounded rendering of the final reply.
  let productEnvelope: ProductSearchEnvelope | null = null;
  // The comparable budget the envelope resolved, in the STORE's currency.
  // Read from the envelope rather than re-derived, so the selection below
  // compares the same numbers the provider quoted.
  let productBudget: { target: number; currency: string } | null = null;
  const replyLocale: "he" | "en" = detectLocale(messages.map((m) => m.body || ""));
  try {
    const disc = await runProductDiscoveryTurn({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      aiAgentId: opts.aiAgentId,
      role: (config as any).role,
      availableToolNames: toolFunctionNames,
      incomingMessageId: (contactRow as any)?.lastInboundMessageId ?? null,
    });
    if (disc.active && disc.snapshot) {
      chatMessages.push({ role: "system", content: disc.snapshot });
      if (disc.decision?.kind === "execute") {
        discoveryForceTool = disc.decision.tool;
        chatMessages.push({
          role: "system",
          content:
            `Enough information exists to search. Call ${disc.decision.tool} NOW. ` +
            `IMPORTANT: the store's product catalog is searched by product TITLE, which is in ENGLISH. ` +
            `Set the query to the ENGLISH product-category noun ONLY (e.g. "snowboard") - do NOT put length, flex, riding style, price or Hebrew words in the query; the store cannot filter by those and a specific query returns nothing. ` +
            `Apply budget/length/flex yourself when choosing which returned products to present. ` +
            `Do NOT ask more questions and do NOT describe products from general knowledge - only real results from the tool may be shown.`,
        });
      } else if (disc.decision?.kind === "blocked_no_tool") {
        chatMessages.push({
          role: "system",
          content:
            "You have enough information to search, but the live product catalog is not available to you this conversation. " +
            "Do NOT invent products or claim you searched. Briefly say you cannot pull the live catalog right now and offer to connect the customer with a person from the team.",
        });
      }
    }
  } catch (err: any) {
    console.warn("[ai-bot] discovery integration failed (non-fatal):", err?.message);
  }

  // ── Variant / stock questions are a LOOKUP, not a diagnosis ──────────
  // The support persona's objective is RESOLVE_ISSUE and it is told to ask
  // only what it needs to diagnose - so "יש את הדגם הזה במידה 159?" got a
  // question back about which colour was meant, on a catalogue whose products
  // have one variant each. The answer was one call away the whole time.
  // Coupons are out of scope for customer conversations. The tools are already
  // off this surface; this stops the model improvising in their absence.
  try {
    if (detectCouponIntent(opts.incomingMessage)) {
      chatMessages.push({ role: "system", content: buildCouponUnsupportedDirective() });
    }
    // "Write this on my order" - the model kept claiming the write instead of
    // performing it.
    if (detectOrderNoteIntent(opts.incomingMessage)) {
      chatMessages.push({ role: "system", content: buildOrderNoteDirective() });
    }
    // "Change my email" - the record is theirs, and the tool takes no id.
    if (detectProfileUpdateIntent(opts.incomingMessage)) {
      chatMessages.push({
        role: "system",
        content: buildProfileUpdateDirective({
          hasProfileTool: toolFunctionNames.some((n) => n.endsWith(".update_my_profile")),
        }),
      });
    }
    // Redirecting an order: possible before dispatch, and a lie after it.
    if (detectOrderAddressIntent(opts.incomingMessage)) {
      chatMessages.push({
        role: "system",
        content: buildOrderAddressDirective({
          hasAddressTool: toolFunctionNames.some((n) => n.endsWith(".update_order_shipping_address")),
        }),
      });
    }
    // "Invoice" is at least three different documents, and only some exist.
    const docType = detectDocumentRequest(opts.incomingMessage);
    if (docType) {
      chatMessages.push({
        role: "system",
        content: buildDocumentDirective(
          resolveDocumentCapability(docType, {
            shopifyConnected: toolFunctionNames.some((n) => n.startsWith("shopify.")),
            // Nothing in this deployment's integration catalog issues tax
            // documents, so this stays null until one exists. Inferring an
            // invoicing provider from a connected CRM is how an order summary
            // gets called a tax invoice.
            invoicingProvider: null,
            canSendWhatsAppMedia: false,
            hasCustomerEmail: !!resolvedCustomerEmail,
          }),
        ),
      });
    }
    // Returns: ONE provider creates them, and only a real id may be claimed.
    if (detectReturnIntent(opts.incomingMessage)) {
      const caps = await getReturnProvider(opts.tenantId);
      chatMessages.push({ role: "system", content: buildReturnDirective(caps) });
    }
    // An exchange is an order edit before dispatch and a return after it.
    if (detectExchangeIntent(opts.incomingMessage)) {
      chatMessages.push({
        role: "system",
        content: buildExchangeDirective({
          hasExchangeTool: toolFunctionNames.some((n) => n.endsWith(".exchange_order_item")),
        }),
      });
    }
    // A missing item is arithmetic the bot can do, not an identity check.
    if (detectMissingItemIntent(opts.incomingMessage)) {
      chatMessages.push({
        role: "system",
        content: buildMissingItemDirective({
          hasReconcileTool: toolFunctionNames.some((n) => n.endsWith(".reconcile_order_items")),
        }),
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] coupon intent detection failed (non-fatal):", err?.message);
  }

  // ── Deterministic flow control for the irreversible Shopify flows ──────
  //
  // The directives above tell the model what to do. This decides it. For the
  // flows where a mistake is irreversible or spends a human decision, the facts
  // are resolved here - which order, which line, which variant, what it costs,
  // whether it is still eligible - before the model is asked to say anything.
  // It receives verified facts and at most ONE permitted call with its
  // arguments already filled in.
  //
  // Part 5 ended with the mechanisms stronger than the behaviour they were
  // containing: a human approved an exchange with no replacement variant in it,
  // and a colour question was answered from a product the model had guessed.
  // Both are gone when the model no longer chooses the move.
  try {
    resolvedFlow = await runFlowController({
      message: opts.incomingMessage ?? "",
      anchoredOrderName: anchoredOrderName ?? null,
      availableTools: toolFunctionNames,
      call: async (tool, args) => {
        const r = await executeAdapterTool({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          contactId: contactRow?.id,
          toolFunctionName: tool,
          args,
          accessScope: "customer",
        });
        if (!r.ok) throw new Error(r.reason);
        return r.result;
      },
    });
    const block = renderFlowDirective(resolvedFlow);
    if (block) {
      console.log(`[ai-bot][flow] ${resolvedFlow.kind} intent=${(resolvedFlow as any).intent} conv=${opts.conversationId}`);
      chatMessages.push({ role: "system", content: block });
    }
  } catch (err: any) {
    console.warn("[ai-bot] flow controller failed (non-fatal):", err?.message);
  }

  try {
    const variantIntent = detectVariantIntent(opts.incomingMessage);
    const hasVariantTool = toolFunctionNames.some((n) => n.endsWith(".variant_information"));
    console.log(
      `[ai-bot][variant-intent] question=${variantIntent.isVariantQuestion} toolAvailable=${hasVariantTool} tools=${toolFunctionNames.length} names=${toolFunctionNames.join(",")}`,
    );
    if (variantIntent.isVariantQuestion && hasVariantTool) {
      chatMessages.push({
        role: "system",
        content: buildVariantIntentDirective(variantIntent, replyLocale),
      });
    }
  } catch (err: any) {
    console.warn("[ai-bot] variant intent detection failed (non-fatal):", err?.message);
  }
  // Outside-hours context ("active" policy): the business is CLOSED right now.
  // The bot keeps helping, but must never imply a human is immediately
  // available - handoff talk names the REAL next opening time (worker-
  // computed from the tenant's persisted schedule + timezone). A separate
  // system block (not part of the stable agent prompt) because it appears
  // and disappears with the clock, and the stable prefix must stay cacheable.
  if (opts.closedHours) {
    const ch = opts.closedHours;
    chatMessages.push({
      role: "system",
      content:
        `# OUTSIDE BUSINESS HOURS\n` +
        `The business is currently CLOSED. Human team members are NOT available right now; ` +
        `they return ${ch.nextOpeningText?.en || "during the next business hours"}` +
        (ch.nextOpeningText?.he ? ` (Hebrew wording: "${ch.nextOpeningText.he}")` : "") +
        `.\nRules:\n` +
        `- Keep helping the customer normally with everything you can do yourself.\n` +
        `- If the customer needs a human, or you would escalate, say the team will get back to them ${ch.nextOpeningText?.en || "when the business reopens"} (use the Hebrew wording above when replying in Hebrew).\n` +
        `- NEVER imply immediate human availability ("right away", "shortly", "connecting you now").\n` +
        `- Do not invent different hours or reopening times.`,
    });
  }
  // The output-contract instruction is now rendered inside the per-turn
  // block of the system prompt (see buildExecutionContract). Sending it
  // ALSO as a separate user message at index 1 was injecting BEL-driven
  // content into the chatMessages prefix, which broke the cache layout
  // every time the contract flipped (REPLY → READY_MESSAGE → ...). The
  // model still sees the same instruction - just once, in the system
  // prompt - so behavior is unchanged.

  for (const m of messages) {
    if (!m.body?.trim()) continue;
    if ((m as any).messageType === "system") continue;
    chatMessages.push({
      role: m.direction === "INBOUND" ? "user" : "assistant",
      content: m.body,
    });
  }

  // When a meeting is already on the calendar for this conversation, tell the
  // model so a "move it" / "cancel it" request routes to reschedule_meeting /
  // cancel_meeting instead of schedule_meeting (which would duplicate the event).
  if (existingBooking) {
    const whenIso = new Date(existingBooking.startMs).toISOString();
    const durMin = Math.max(15, Math.round((existingBooking.endMs - existingBooking.startMs) / 60_000));
    chatMessages.push({
      role: "system",
      content:
        `📅 ACTIVE MEETING: a meeting is already booked in this conversation for ${whenIso} (${durMin} min). ` +
        `If the customer wants to MOVE/change the time, call reschedule_meeting with the new time. ` +
        `If they want to CANCEL it, call cancel_meeting. ` +
        `NEVER call schedule_meeting again for this customer - that creates a DUPLICATE event.`,
    });
  }

  const model = config.model || getDefaultModel();
  let pendingEscalation: AIBotReplyResult["escalation"] = null;
  let awaitingApproval: AIBotReplyResult["awaitingApproval"] = null;
  let replyText: string | null = null;
  let totalTokens = 0;
  // Pre-tool acks ("one moment, checking") to send as their OWN bubble(s)
  // BEFORE the final reply. Populated when the model acks alongside a calendar
  // tool call. The worker sends these first, then the reply (two-bubble flow).
  const interimMessages: string[] = [];
  const toolCallLog: AIBotReplyResult["toolCallLog"] = [];
  // Turn Outcome Ledger - single source of truth for side effects this turn.
  // Passed to every orchestrator.submit() so duplicate semantic actions dedup
  // and a committed success can never be downgraded by a later failure.
  const ledger = new TurnOutcomeLedger();
  const ledgerCtx = { contactId: contactRow?.id };
  // Inject the authoritative committed-outcome block into the model context at
  // most once per turn (the first time a side effect commits) so the reply is
  // DERIVED FROM ledger state. Shared across the main loop, the contract retry,
  // and the consistency regen (all append to the same chatMessages array).
  let committedSummaryInjected = false;
  const injectCommittedSummaryIfNeeded = () => {
    if (committedSummaryInjected) return;
    const block = buildCommittedOutcomeBlock(ledger);
    if (block) {
      chatMessages.push({ role: "system", content: block });
      committedSummaryInjected = true;
    }
  };
  // The Customer Outcome Contract, injected BEFORE the reply is written rather
  // than validated after it. Checking output can only delete a sentence; this
  // is what lets the reply be right the first time. Re-pushed when the facts
  // change - a later round can complete an action the earlier block did not
  // know about, and a stale fact list is exactly the wrong thing to hand a
  // model that is about to speak.
  let lastOutcomeBlock: string | null = null;
  const injectOutcomeFacts = () => {
    const block = buildOutcomeFactBlock(buildOutcome(toolCallLog));
    if (block && block !== lastOutcomeBlock) {
      chatMessages.push({ role: "system", content: block });
      lastOutcomeBlock = block;
    }
  };

  for (let round = 0; round < 3; round++) {
    const response = await generateResponse({
      tenantId: opts.tenantId,
      // Pin every autonomous turn of the SAME conversation to one session so
      // OpenAI's automatic prefix cache routes consistently across turns.
      // Without this, multiple turns of the same conversation may land on
      // different backends and miss the cache - silently doubling token cost.
      sessionId: opts.conversationId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      tools: tools as any[],
      // Discovery says we are ready and the real product tool is offered:
      // force it on the first round so the model executes a real search
      // instead of narrating one. Cleared after round 0.
      ...(round === 0 && discoveryForceTool
        ? { toolChoice: { type: "function", function: { name: discoveryForceTool } } }
        : {}),
      metadata: { type: "ai_bot", conversationId: opts.conversationId, aiAgentId: config.id, turnId: shadowTurnId },
      signal,
    });

    totalTokens += response.usage.total_tokens || 0;
    budget.addUsage(response.usage.total_tokens || 0);
    if (budget.exceededTurnCap()) {
      auditBudgetAbort({
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        scope: "turn",
        used: budget.tokensThisTurn(),
        cap: budget.caps.perTurn,
        details: { stage: "main_loop", round },
      });
      // Accept whatever text we have (possibly empty); abort the loop.
      replyText = response.content?.trim() || null;
      break;
    }

    const toolCalls = response.toolCalls;
    if (toolCalls && toolCalls.length > 0) {
      chatMessages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: toolCalls,
      });

      // Two-bubble flow: when the model emits a short ack ALONGSIDE a calendar
      // tool call (schedule/reschedule/cancel - these have real check latency),
      // send that ack as its OWN message now; the post-tool reply becomes the
      // second bubble ("רגע אחד, בודק 🙏" → "הפגישה ב-17:00, להעביר ל-11:00?").
      const callsCalendarTool = toolCalls.some((t) =>
        /^(check_availability|schedule_meeting|reschedule_meeting|cancel_meeting)$/.test(t.function?.name || ""),
      );
      const ackText = response.content?.trim();
      if (callsCalendarTool && ackText && !interimMessages.includes(ackText)) {
        interimMessages.push(ackText);
      }

      let pausedForApproval: AIBotReplyResult["awaitingApproval"] = null;
      for (const tc of toolCalls) {
        const toolName = tc.function?.name || "unknown";
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

        // Required-input gate - structurally refuse to execute a tool before its
        // schema-required inputs exist (OpenAI does not enforce `required`). The
        // model gets a tool result telling it to collect the missing values
        // first, so a half-formed write never fires. See BLOCK 0 Tool Execution.
        // Two sources of required inputs, unioned: (1) the tool's own JSON
        // schema `required` (covers well-formed core tools), and (2) the Tool
        // Contract registry (defense-in-depth for integration/catalog tools
        // whose per-tenant schemas we don't control - see tool-contracts.ts).
        const schemaMissing = missingRequiredArgs(toolName, toolArgs, tools as any[]);
        const contractGateInputs = missingContractInputs(toolName, toolArgs);
        const missingInputs = Array.from(
          new Set([...schemaMissing, ...contractGateInputs.missing]),
        );
        if (missingInputs.length > 0) {
          const collect =
            contractGateInputs.strategy === "ask_all" || missingInputs.length === 1
              ? `Ask the customer for the missing values (${missingInputs.join(", ")})`
              : `Ask the customer for ONE missing value at a time (start with: ${missingInputs[0]})`;
          const gateContent = JSON.stringify({
            ok: false,
            error: "missing_required_inputs",
            missing_inputs: missingInputs,
            instruction: `Do NOT call ${toolName} yet. ${collect}, then call it once you have them.`,
          });
          toolCallLog.push({
            tool: toolName,
            args: toolArgs,
            result: gateContent,
            decision: "missing_required_inputs",
            sideEffect: "missing_required_inputs",
          });
          chatMessages.push({ role: "tool", tool_call_id: tc.id, content: gateContent });
          continue;
        }

        // Exit-criteria gate - refuse to close the conversation until
        // the resolved funnel stage's `mustHaveFields` have evidence.
        // Defense-in-depth on top of the prompt-level instruction.
        const exitGate = checkExitCriteriaGate(toolName, stageContext, {
          email: contactRow?.email,
          phone: contactRow?.phone,
          transcript: messages.map((m) => m.body || "").join("\n"),
        });
        if (exitGate.blocked) {
          const gateContent = JSON.stringify({
            ok: false,
            error: exitGate.reason,
            exit_criteria_gate: true,
            missing_fields: exitGate.missing,
            stage: exitGate.stageLabel,
          });
          toolCallLog.push({
            tool: toolName,
            args: toolArgs,
            result: gateContent,
            decision: "exit_criteria_blocked",
            sideEffect: "exit_criteria_blocked",
          });
          prisma.auditLog
            .create({
              data: {
                tenantId: opts.tenantId,
                actorType: "system",
                action: "ai.exit_criteria_blocked",
                targetType: "conversation",
                targetId: opts.conversationId,
                metadata: {
                  tool: toolName,
                  reason: exitGate.reason,
                  missing: exitGate.missing,
                  stage: exitGate.stageLabel,
                  source: "ai_bot",
                } as any,
              },
            })
            .catch((err: any) => console.error(`[ai-bot] exit_criteria_blocked audit failed:`, err?.message));
          chatMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: gateContent,
          });
          continue;
        }

        // (Removed: the BEL allowedActions gate and the Action-Contract dispatch
        // gate. Both were disabled stubs - `checkAllowedActionsGate` /
        // `checkContractGate` returned `{blocked:false}` by user mandate - so these
        // call sites were unreachable dead code. Move-selection is still steered by
        // the behavior prompt; contract progress is still tracked below.)

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
          { ledger, ctx: ledgerCtx, idempotency: true },
        );
        const result = unwrapToolExec(tc.id, toolName, exec);

        const sideEffectType = result.sideEffect?.awaitingApproval ? "awaiting_approval"
          : result.sideEffect?.denied ? "denied"
          : result.sideEffect?.escalate ? "escalate"
          // A simulated write must be visible in the log, otherwise the sandbox
          // cannot tell the operator which action it declined to perform.
          : result.sideEffect?.simulated ? "simulated"
          : undefined;

        // INVARIANT: a tool we OFFERED to the model must be dispatchable. If a
        // surfaced tool is policy-DENIED at dispatch, the surface pre-filter and
        // the policy gate disagree - the model wasted a round on a tool it could
        // never run. This should be impossible (the pre-filter drops DENY tools
        // before they're offered); log loudly so a config/lookup gap surfaces
        // instead of silently degrading into a dead-end or escalation.
        if (sideEffectType === "denied" && toolFunctionNames.includes(toolName)) {
          console.error(
            `[ai-bot] INVARIANT VIOLATION: surfaced tool "${toolName}" was DENIED at dispatch ` +
              `(reason: ${result.sideEffect?.denied?.reason ?? "unknown"}). The model was offered a tool ` +
              `it cannot execute. Check evaluatePolicies vs the surface filter for conv=${opts.conversationId}.`,
          );
        }

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
              // Capability Runtime shadow join keys (Conversation→Turn→ToolCall).
              turnId: shadowTurnId,
              toolCallId: tc.id,
            },
          },
        }).catch((err: any) => console.error(`[ai-bot] Tool call audit failed for ${toolName}:`, err.message));

        if (result.sideEffect?.escalate) pendingEscalation = result.sideEffect.escalate;
        if (result.sideEffect?.awaitingApproval && !pausedForApproval) {
          pausedForApproval = result.sideEffect.awaitingApproval;
        }

        // Action Contract progress - record this tool execution against
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

        // ── Typed product-result path (ISOLATED to Shopify product search) ──
        // Normalize the raw result into the canonical envelope, stash it for
        // deterministic rendering, and give the MODEL only a safe keyed summary
        // (PRODUCT_1..N, no URLs/prices to copy). Generic tools are untouched.
        let toolContent = result.content;
        if (
          process.env.DISCOVERY_TYPED_PRODUCT_RENDER !== "off" &&
          isProductSearchTool(toolName)
        ) {
          try {
            const envlp = await groundProductSearchResult({
              tenantId: opts.tenantId,
              conversationId: opts.conversationId,
              toolName,
              rawContent: result.content,
            });
            if (envlp) {
              productEnvelope = envlp;
              productBudget = envlp.budget ?? null;
              toolContent = buildKeyedModelSummary(envlp, replyLocale);
            }
          } catch (err: any) {
            console.warn("[ai-bot] typed product path failed (using raw result):", err?.message);
          }
        }
        chatMessages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: toolContent,
        });
      }

      // Ledger-driven: once a side effect has committed, inject the
      // authoritative outcome block BEFORE the next round produces the
      // customer-facing reply, so that reply is derived from ledger truth.
      injectCommittedSummaryIfNeeded();
      injectOutcomeFacts();

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
  // Silent BACKGROUND CRM writes (create lead/contact/deal, tag, note, update)
  // must NOT be force-injected mid-turn. Forcing "call create_lead NOW" makes
  // the model fire it with empty args before it has the data, and any failure
  // (missing scopes, validation) then gets surfaced to the customer and derails
  // the conversation ("there was a technical problem creating your lead"). These
  // are best-effort: the model calls them naturally once it has the fields, and
  // the post-conversation pipeline is the backstop. Only NON-background unmet
  // actions (e.g. identity_link) are force-retried.
  const SILENT_BACKGROUND_ACTIONS = new Set<string>([
    "create_lead",
    "create_contact",
    "create_deal",
    "update_record",
    "add_note",
    "tag",
    "log_activity",
  ]);
  const unmetToForce = unmetRequired.filter((u) => !SILENT_BACKGROUND_ACTIONS.has(String(u.action)));

  // ── Action Contract violations (tool-name level) ──────────────
  // (Removed: post-loop recomputation of still-pending blocking-contract tools.
  // Action-Contract co-steps are best-effort - that block only `console.warn`ed the
  // pending tools; the force-retry it once fed was already removed. Genuine BEL
  // required actions still force a retry via `unmetToForce` below.)

  if (
    unmetToForce.length > 0 &&
    !awaitingApproval &&
    !pendingEscalation &&
    !budget.exceededTurnCap()
  ) {
    const reasonParts: string[] = [
      `Missing required tools: ${unmetToForce.map((u) => `\`${u.toolName}\` (for \`${u.action}\`)`).join(", ")}.`,
    ];
    console.warn(`[ai-bot] Required-action gap - ${reasonParts.join(" | ")}. Forcing retry.`);
    chatMessages.push({
      role: "user",
      content:
        `**MISSING REQUIRED ACTION.** ${reasonParts.join(" ")} ` +
        `You MUST call the missing tool(s) NOW before producing any reply text. ` +
        `This is the regeneration the original prompt warned about. Do not skip again.` + INTERNAL_NUDGE_LANGUAGE_PIN,
    });

    const retryResponse = await generateResponse({
      tenantId: opts.tenantId,
      sessionId: opts.conversationId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      tools: tools as any[],
      metadata: { type: "ai_bot_retry", conversationId: opts.conversationId, aiAgentId: config.id, turnId: shadowTurnId },
      signal,
    });
    totalTokens += retryResponse.usage.total_tokens || 0;
    budget.addUsage(retryResponse.usage.total_tokens || 0);

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
          { ledger, ctx: ledgerCtx, idempotency: true },
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
      // Final pass to get the customer-facing reply text - unless the
      // per-turn budget already tripped on the retry, in which case we
      // ship whatever the retry already produced.
      if (budget.exceededTurnCap()) {
        auditBudgetAbort({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          scope: "turn",
          used: budget.tokensThisTurn(),
          cap: budget.caps.perTurn,
          details: { stage: "contract_retry_skip_final" },
        });
        if (retryResponse.content?.trim()) replyText = retryResponse.content.trim();
      } else {
        const finalResp = await generateResponse({
          tenantId: opts.tenantId,
          sessionId: opts.conversationId,
          model,
          messages: chatMessages,
          temperature: config.temperature ?? 0.7,
          maxTokens: config.maxTokens ?? 1024,
          tools: tools as any[],
          metadata: { type: "ai_bot_retry_final", conversationId: opts.conversationId, aiAgentId: config.id, turnId: shadowTurnId },
          signal,
        });
        totalTokens += finalResp.usage.total_tokens || 0;
        budget.addUsage(finalResp.usage.total_tokens || 0);
        if (finalResp.content?.trim()) replyText = finalResp.content.trim();
      }
    } else {
      // Model still didn't call. Use whatever text it returned and log the persistent violation.
      console.warn(`[ai-bot] Contract violation persists after retry. Accepting reply anyway.`);
      if (retryResponse.content?.trim()) replyText = retryResponse.content.trim();
    }
  }

  // ── Action Preference (Unit B) ──────────────────────────────────
  // Goal ownership creates pressure to ACT, not narrate. If the committed goal
  // has a RIPE action - its completion tool is dispatchable this turn AND every
  // REQUIRED input is already captured AND policy allows it (exactly the
  // condition under which resolveNextActions emits an `act` candidate) - but the
  // model produced a NON-ADVANCING reply (passive closer / generic opener) and
  // executed nothing, re-roll ONCE with tool_choice:"required" so the model must
  // commit to a tool instead of talking. This is intelligent PREFERENCE, not
  // blind forcing: it fires only when an action is genuinely ready and the turn
  // would otherwise be pure talk, and the model still picks WHICH tool. The
  // dispatch input/policy/approval gates run on the forced call exactly as in the
  // main loop, so an under-specified or disallowed write can never slip through -
  // worst case the model is steered back to asking for the one missing value.
  // Generic + metadata-driven: the trigger is the goal's readiness, never a
  // specific tool name, so it covers background AND customer-facing actions alike.
  {
    const actionAlreadyTaken = toolCallLog.some(
      (t) =>
        (t.decision === "executed" || t.decision === "executed_on_retry") &&
        TOOL_OK_RE.test(String(t.result ?? "")),
    );
    const apFactText = [ctxSlot.customerBlock, ctxSlot.crmBlock, ctxSlot.memoryBlock, ctxSlot.sessionFactsBlock]
      .filter((s): s is string => !!s && !!s.trim())
      .join("\n");
    const apProspectState = computeProspectState({
      hasLead: crmHasLead,
      hasContact: !!crmBlock || crmHasLead || crmHasCustomer,
      isCustomer: crmHasCustomer,
    });
    const apCommitted = toolCallLog
      .filter(
        (t) =>
          (t.decision === "executed" || t.decision === "executed_on_retry") &&
          TOOL_OK_RE.test(String(t.result ?? "")),
      )
      .map((t) => t.tool);
    // Respect goal ownership (Unit A): reconcile against the committed goal so a
    // HELD objective's ready action is the one we prefer.
    const { status: apStatus } = commitObjective(
      priorGoal,
      selectActiveObjective(
        config.role,
        apProspectState,
        apFactText,
        [...new Set([...committedActionTools, ...apCommitted])],
        calendarCapability.bookable,
        wizardFacts.goalObjective,
      ),
      apFactText,
    );
    const ripeAct = resolveNextActions({
      status: apStatus,
      capability: toolFunctionNames,
      calendarBookable: calendarCapability.bookable,
      qualificationMet: wizardFacts.qualificationMet,
    }).find((c) => c.kind === "act" && !!c.tool);

    // Wizard→Runtime: never FORCE a conversion action (booking/deal) on a prospect
    // who matches a configured disqualifier - the configured poor-fit signal must
    // override the action-preference push. Soft + per-turn: the model may still
    // offer it, we just don't compel it. Background actions remain guaranteed.
    const apDisqualified = wizardFacts.fit === "disqualified";
    if (apDisqualified && ripeAct?.tool) {
      console.log(`[ai-bot][qualify-out] configured disqualifier matched - NOT forcing ${ripeAct.tool}. convo=${opts.conversationId}`);
    }

    if (
      ripeAct?.tool &&
      !apDisqualified &&
      !actionAlreadyTaken &&
      isNonAdvancingReply(replyText) &&
      !awaitingApproval &&
      !pendingEscalation &&
      !budget.exceededTurnCap()
    ) {
      console.log(
        `[ai-bot][action-preference] committed goal has a RIPE act (${ripeAct.tool}) but the reply was ` +
          `non-advancing and nothing executed - forcing tool_choice=required. convo=${opts.conversationId}`,
      );
      chatMessages.push({
        role: "user",
        content:
          `A concrete action is ready that advances the current goal, and every input it needs is already known. ` +
          `Do NOT keep discussing or close the conversation - call the tool that advances the goal NOW, ` +
          `then write your reply based on its real result.` + INTERNAL_NUDGE_LANGUAGE_PIN,
      });
      const apResponse = await generateResponse({
        tenantId: opts.tenantId,
        sessionId: opts.conversationId,
        model,
        messages: chatMessages,
        temperature: config.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? 1024,
        tools: tools as any[],
        // Force the SPECIFIC ripe tool, not a bare "required". With "required"
        // the model can satisfy the constraint by grabbing the always-present
        // escalate_to_human (observed: a stray escalate fired under forcing).
        // Naming the goal's ready tool keeps this preference, not a handoff - and
        // it stays generic (the tool comes from the NBA, never hardcoded).
        toolChoice: { type: "function", function: { name: ripeAct.tool } },
        metadata: { type: "ai_bot_action_preference", conversationId: opts.conversationId, aiAgentId: config.id },
        signal,
      });
      totalTokens += apResponse.usage.total_tokens || 0;
      budget.addUsage(apResponse.usage.total_tokens || 0);

      const apToolCalls = apResponse.toolCalls;
      if (apToolCalls && apToolCalls.length > 0) {
        chatMessages.push({ role: "assistant", content: apResponse.content || "", tool_calls: apToolCalls });
        for (const tc of apToolCalls) {
          const toolName = tc.function?.name || "unknown";
          let toolArgs: Record<string, unknown> = {};
          try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

          // Same required-input backstop as the main loop: a forced call must
          // never fire an under-specified write. If inputs are missing, return
          // the gate result and let the model ask for them instead.
          const apMissing = Array.from(
            new Set([
              ...missingRequiredArgs(toolName, toolArgs, tools as any[]),
              ...missingContractInputs(toolName, toolArgs).missing,
            ]),
          );
          if (apMissing.length > 0) {
            const gateContent = JSON.stringify({
              ok: false,
              error: "missing_required_inputs",
              missing_inputs: apMissing,
              instruction: `Do NOT call ${toolName} yet. Ask the customer for the missing values (${apMissing.join(", ")}) first, then call it.`,
            });
            toolCallLog.push({
              tool: toolName,
              args: toolArgs,
              result: gateContent,
              decision: "missing_required_inputs",
              sideEffect: "missing_required_inputs",
            });
            chatMessages.push({ role: "tool", tool_call_id: tc.id, content: gateContent });
            continue;
          }

          const exec = await getActionOrchestrator().submit(
            {
              id: randomUUID(),
              conversationId: agentToolCtx.conversationId ?? "",
              tenantId: agentToolCtx.tenantId,
              proposedBy: { mode: "chat", system: "ai-bot:action-preference" },
              actor: { agentId: "" },
              tool: toolName,
              args: toolArgs,
              rationale: "ai-bot action-preference (RIPE goal action)",
              urgency: "low",
            },
            () =>
              dispatchToolCall(
                { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
                agentToolCtx,
              ),
            { ledger, ctx: ledgerCtx, idempotency: true },
          );
          const result = unwrapToolExec(tc.id, toolName, exec);
          toolCallLog.push({
            tool: toolName,
            args: toolArgs,
            result: result.content,
            decision: "executed_on_retry",
            sideEffect: undefined,
          });

          // Same contract-progress tracking as the main loop / required retry.
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

          chatMessages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
        }
        // Final pass: derive the customer-facing reply from the action's real
        // result (unless the turn budget tripped, in which case ship what we have).
        if (!budget.exceededTurnCap()) {
          const apFinal = await generateResponse({
            tenantId: opts.tenantId,
            sessionId: opts.conversationId,
            model,
            messages: chatMessages,
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 1024,
            tools: tools as any[],
            metadata: { type: "ai_bot_action_preference_final", conversationId: opts.conversationId, aiAgentId: config.id },
            signal,
          });
          totalTokens += apFinal.usage.total_tokens || 0;
          budget.addUsage(apFinal.usage.total_tokens || 0);
          if (apFinal.content?.trim()) replyText = apFinal.content.trim();
        } else if (apResponse.content?.trim()) {
          replyText = apResponse.content.trim();
        }
      }
    }
  }

  // ── Failure Recovery (Unit C) ────────────────────────────────────
  // A committed goal creates pressure toward RECOVERY, not handoff. If a
  // goal-advancing action was ATTEMPTED this turn but FAILED (ok:false), a strong
  // owner does not give up or escalate on the first hiccup - they retry with
  // corrected inputs, use a different tool that reaches the same outcome, ask the
  // customer for the one detail that was missing/rejected, or offer a workaround;
  // escalation is the LAST resort. This runs ONE bounded recovery re-roll and,
  // when the failure-driven escalation is avoidable (the customer didn't ask for a
  // human AND a non-escalate advancing move still exists), HOLDS that escalation
  // so recovery is tried first. Fully generic: a "failed action" is any non-read
  // tool that returned ok:false; recovery is driven by the committed goal's
  // readiness, never by the tool's identity (no booking/CRM/integration logic).
  {
    const isReadTool = (t: string) => /(_search|_get|_lookup|_read)$/.test(t);
    const isOk = (r: unknown) => TOOL_OK_RE.test(String(r ?? ""));
    const ranThisTurn = (t: { decision?: string }) =>
      t.decision === "executed" || t.decision === "executed_on_retry";
    const failedActions = toolCallLog.filter(
      (t) => ranThisTurn(t) && !isReadTool(t.tool) && !isOk(t.result),
    );
    const succeededAction = toolCallLog.some(
      (t) => ranThisTurn(t) && !isReadTool(t.tool) && isOk(t.result),
    );

    if (
      failedActions.length > 0 &&
      !succeededAction &&
      !detectHumanHandoff(opts.incomingMessage) &&
      !awaitingApproval &&
      !budget.exceededTurnCap()
    ) {
      // Is there still a non-escalate move toward the committed goal? Only then
      // do we treat a handoff as avoidable and attempt recovery.
      const recFactText = [ctxSlot.customerBlock, ctxSlot.crmBlock, ctxSlot.memoryBlock, ctxSlot.sessionFactsBlock]
        .filter((s): s is string => !!s && !!s.trim())
        .join("\n");
      const recProspect = computeProspectState({
        hasLead: crmHasLead,
        hasContact: !!crmBlock || crmHasLead || crmHasCustomer,
        isCustomer: crmHasCustomer,
      });
      const recCommitted = toolCallLog
        .filter((t) => ranThisTurn(t) && isOk(t.result))
        .map((t) => t.tool);
      const { status: recStatus } = commitObjective(
        priorGoal,
        selectActiveObjective(
          config.role,
          recProspect,
          recFactText,
          [...new Set([...committedActionTools, ...recCommitted])],
          calendarCapability.bookable,
          wizardFacts.goalObjective,
        ),
        recFactText,
      );
      const canStillAdvance = hasViableAdvancingAction(
        resolveNextActions({
          status: recStatus,
          capability: toolFunctionNames,
          calendarBookable: calendarCapability.bookable,
          qualificationMet: wizardFacts.qualificationMet,
        }),
      );

      if (canStillAdvance) {
        // The escalation set this turn was a reflex to the failure, not an
        // explicit customer request → HOLD it; recovery may re-set it only if the
        // recovery round itself decides to escalate (see below).
        if (pendingEscalation) {
          console.log(
            `[ai-bot][recovery] holding failure-driven escalation to attempt recovery first. convo=${opts.conversationId}`,
          );
          pendingEscalation = null;
        }
        const failedNames = [...new Set(failedActions.map((f) => f.tool))];
        let failReason = "";
        try {
          const parsed = JSON.parse(String(failedActions[0].result ?? "{}"));
          failReason = String(parsed?.reason ?? parsed?.error ?? "");
        } catch {/* result not JSON → no reason text */}
        console.log(
          `[ai-bot][recovery] action(s) failed (${failedNames.join(",")}${failReason ? `: ${failReason}` : ""}) - ` +
            `driving recovery before any handoff. convo=${opts.conversationId}`,
        );
        chatMessages.push({
          role: "user",
          content:
            `The action you attempted did not succeed${failReason ? ` (reason: ${failReason})` : ""}, but the goal is still ` +
            `open and you OWN it. Do NOT hand off to a human or give up over one failed attempt. Before escalation is even ` +
            `an option, do the next thing a capable owner would, in order: (1) retry the action with corrected inputs if ` +
            `something was wrong or missing; (2) use a different available tool that reaches the same outcome; (3) ask the ` +
            `customer for the ONE specific detail that was missing or rejected, then proceed; (4) offer a concrete workaround ` +
            `that still advances the goal. Escalate ONLY if none of these is possible. Never expose internal or technical ` +
            `failure details to the customer - keep the reply natural.` + INTERNAL_NUDGE_LANGUAGE_PIN,
        });
        const recResponse = await generateResponse({
          tenantId: opts.tenantId,
          sessionId: opts.conversationId,
          model,
          messages: chatMessages,
          temperature: config.temperature ?? 0.7,
          maxTokens: config.maxTokens ?? 1024,
          tools: tools as any[],
          metadata: { type: "ai_bot_recovery", conversationId: opts.conversationId, aiAgentId: config.id },
          signal,
        });
        totalTokens += recResponse.usage.total_tokens || 0;
        budget.addUsage(recResponse.usage.total_tokens || 0);

        const recToolCalls = recResponse.toolCalls;
        if (recToolCalls && recToolCalls.length > 0) {
          chatMessages.push({ role: "assistant", content: recResponse.content || "", tool_calls: recToolCalls });
          for (const tc of recToolCalls) {
            const toolName = tc.function?.name || "unknown";
            let toolArgs: Record<string, unknown> = {};
            try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}

            const recMissing = Array.from(
              new Set([
                ...missingRequiredArgs(toolName, toolArgs, tools as any[]),
                ...missingContractInputs(toolName, toolArgs).missing,
              ]),
            );
            if (recMissing.length > 0) {
              const gateContent = JSON.stringify({
                ok: false,
                error: "missing_required_inputs",
                missing_inputs: recMissing,
                instruction: `Do NOT call ${toolName} yet. Ask the customer for the missing values (${recMissing.join(", ")}) first, then call it.`,
              });
              toolCallLog.push({
                tool: toolName,
                args: toolArgs,
                result: gateContent,
                decision: "missing_required_inputs",
                sideEffect: "missing_required_inputs",
              });
              chatMessages.push({ role: "tool", tool_call_id: tc.id, content: gateContent });
              continue;
            }

            const exec = await getActionOrchestrator().submit(
              {
                id: randomUUID(),
                conversationId: agentToolCtx.conversationId ?? "",
                tenantId: agentToolCtx.tenantId,
                proposedBy: { mode: "chat", system: "ai-bot:recovery" },
                actor: { agentId: "" },
                tool: toolName,
                args: toolArgs,
                rationale: "ai-bot failure recovery",
                urgency: "low",
              },
              () =>
                dispatchToolCall(
                  { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
                  agentToolCtx,
                ),
              { ledger, ctx: ledgerCtx, idempotency: true },
            );
            const result = unwrapToolExec(tc.id, toolName, exec);
            toolCallLog.push({
              tool: toolName,
              args: toolArgs,
              result: result.content,
              decision: "executed_on_retry",
              sideEffect: undefined,
            });
            // Recovery itself decided to escalate (genuine last resort) → honor it.
            if (result.sideEffect?.escalate) pendingEscalation = result.sideEffect.escalate;

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

            chatMessages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
          }
          // Final pass: reply derived from the recovery action's real result.
          if (!budget.exceededTurnCap()) {
            const recFinal = await generateResponse({
              tenantId: opts.tenantId,
              sessionId: opts.conversationId,
              model,
              messages: chatMessages,
              temperature: config.temperature ?? 0.7,
              maxTokens: config.maxTokens ?? 1024,
              tools: tools as any[],
              metadata: { type: "ai_bot_recovery_final", conversationId: opts.conversationId, aiAgentId: config.id },
              signal,
            });
            totalTokens += recFinal.usage.total_tokens || 0;
            budget.addUsage(recFinal.usage.total_tokens || 0);
            if (recFinal.content?.trim()) replyText = recFinal.content.trim();
          } else if (recResponse.content?.trim()) {
            replyText = recResponse.content.trim();
          }
        } else if (recResponse.content?.trim()) {
          // No tool this round → recovery via missing-info collection / workaround.
          // The ask/workaround reply IS the recovery; accept it (escalation stays held).
          replyText = recResponse.content.trim();
        }
      }
    }
  }

  // ── Objective-completeness gate (block passive closers) ─────────
  // Programmatic enforcement of "never end a live conversation while a
  // revenue objective is incomplete". Prompt instructions alone don't stop
  // the model (proven by the real WhatsApp regression). If the model tried to
  // passive-close while an objective with blockPassiveClose is still open AND
  // the customer didn't actually say goodbye, regenerate ONCE with a
  // corrective that forces a forward move. Skipped during approval/escalation
  // handoffs and when the per-turn budget is spent.
  // Decision context - computed once, used by BOTH the gate and the trace log
  // below. Cheap, pure string-matching; safe even when replyText is null.
  const decisionFactText = [ctxSlot.customerBlock, ctxSlot.crmBlock, ctxSlot.memoryBlock, ctxSlot.sessionFactsBlock]
    .filter((s): s is string => !!s && !!s.trim())
    .join("\n");
  const decisionProspectState = computeProspectState({
    hasLead: crmHasLead,
    hasContact: !!crmBlock || crmHasLead || crmHasCustomer,
    isCustomer: crmHasCustomer,
  });
  // Include THIS turn's successful action tools so the post-reply objective view
  // reflects a booking that just landed (consistent with the prompt-time view).
  const thisTurnCommitted = toolCallLog
    .filter(
      (t) =>
        (t.decision === "executed" || t.decision === "executed_on_retry") &&
        TOOL_OK_RE.test(String(t.result ?? "")),
    )
    .map((t) => t.tool);
  const freshDecisionObjStatus = selectActiveObjective(
    config.role,
    decisionProspectState,
    decisionFactText,
    [...new Set([...committedActionTools, ...thisTurnCommitted])],
    calendarCapability.bookable,
    wizardFacts.goalObjective,
  );
  // GOAL OWNERSHIP (Unit A): reconcile against the committed goal (incl. this
  // turn's landed actions) → the objective to act on AND the snapshot to persist
  // for next turn. This is what stops the agent regressing/restarting.
  const { status: decisionObjStatus, snapshot: nextGoalSnapshot } = commitObjective(
    priorGoal,
    freshDecisionObjStatus,
    decisionFactText,
  );

  // GOAL EVALUATOR (separate from navigation): did the configured business
  // OUTCOME happen? Pure projection over runtime homes (CRM flags + active
  // booking + this-turn ledger) + capability + fit + approval. Drives the
  // passive-close backstop so "no next objective" never means "you may close"
  // while a business outcome is still pending. Null → no business goal → BEL owns it.
  const decisionGoalStatus = evaluateGoalStatus({
    goalObjective: resolveGoalObjective(config.role, wizardFacts.goalObjective),
    presentOutcomes: presentBusinessOutcomes({
      crmFlags,
      hasActiveBooking: hasExistingBooking,
      liveOutcomes: businessOutcomesFromLedger(ledger.customerFacingCommitted()),
    }),
    capabilities: groupToolsIntoCapabilities(toolFunctionNames, toolCapabilityHints).map((g) => g.capability),
    fit: wizardFacts.fit,
    approvalPending: !!awaitingApproval,
  });
  const goalOutcomePending =
    !!decisionGoalStatus && (decisionGoalStatus.kind === "ACTIVE" || decisionGoalStatus.kind === "BLOCKED");

  // ── Guaranteed Background Actions (deterministic CRM integrity) ──────────
  // A background CRM write (create lead/contact/deal) whose objective's required
  // info is already present MUST happen this turn - never left to whether the
  // model remembered to call it (the audit's 65 missed create_lead). Runs a
  // SILENT, tool-only round per ripe background action against a COPY of the
  // message thread, so it NEVER changes the customer reply. Deliberately NOT
  // gated on awaitingApproval: an approval pending on one action must not freeze
  // CRM integrity on others (capability "continue progress during approval").
  {
    const committedSoFar = [...new Set([...committedActionTools, ...thisTurnCommitted])];
    const ripeBackground = guaranteedBackgroundActions({
      role: config.role,
      prospectState: decisionProspectState,
      factText: decisionFactText,
      committedTools: committedSoFar,
    });
    for (const { tool: bgTool } of ripeBackground) {
      if (budget.exceededTurnCap()) break;
      if (thisTurnCommitted.includes(bgTool)) continue;
      if (!toolFunctionNames.includes(bgTool)) continue; // only force a tool the agent actually has
      console.log(`[ai-bot][guaranteed-bg] ripe background action ${bgTool} not yet run - forcing silently. convo=${opts.conversationId}`);
      const bgMessages = [
        ...chatMessages,
        {
          role: "user",
          content:
            `SYSTEM: A background CRM record is ready and must be created now. Call \`${bgTool}\` ` +
            `using the customer details already in context. This is a SILENT background action - it ` +
            `does NOT change your reply to the customer; produce only the tool call.` + INTERNAL_NUDGE_LANGUAGE_PIN,
        },
      ];
      const bgResp = await generateResponse({
        tenantId: opts.tenantId,
        sessionId: opts.conversationId,
        model,
        messages: bgMessages,
        temperature: config.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? 1024,
        tools: tools as any[],
        toolChoice: { type: "function", function: { name: bgTool } },
        metadata: { type: "ai_bot_guaranteed_bg", conversationId: opts.conversationId, aiAgentId: config.id },
        signal,
      });
      totalTokens += bgResp.usage.total_tokens || 0;
      budget.addUsage(bgResp.usage.total_tokens || 0);
      for (const tc of bgResp.toolCalls || []) {
        const toolName = tc.function?.name || "unknown";
        if (toolName !== bgTool) continue; // forced single tool; ignore anything else
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        // Structural backstop: never fire an under-specified write. If the args
        // aren't actually derivable, skip SILENTLY - do not pester the customer.
        const missingInputs = Array.from(
          new Set([
            ...missingRequiredArgs(toolName, toolArgs, tools as any[]),
            ...missingContractInputs(toolName, toolArgs).missing,
          ]),
        );
        if (missingInputs.length > 0) {
          console.warn(`[ai-bot][guaranteed-bg] ${bgTool} missing inputs (${missingInputs.join(",")}) - skipping silent create.`);
          continue;
        }
        const exec = await getActionOrchestrator().submit(
          {
            id: randomUUID(),
            conversationId: agentToolCtx.conversationId ?? "",
            tenantId: agentToolCtx.tenantId,
            proposedBy: { mode: "chat", system: "ai-bot:guaranteed-bg" },
            actor: { agentId: "" },
            tool: toolName,
            args: toolArgs,
            rationale: "ai-bot guaranteed background action (RIPE objective completion tool)",
            urgency: "low",
          },
          () =>
            dispatchToolCall(
              { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
              agentToolCtx,
            ),
          { ledger, ctx: ledgerCtx, idempotency: true },
        );
        const result = unwrapToolExec(tc.id, toolName, exec);
        toolCallLog.push({ tool: toolName, args: toolArgs, result: result.content, decision: "executed_on_retry", sideEffect: "background" });
        if (TOOL_OK_RE.test(result.content)) thisTurnCommitted.push(toolName);
      }
    }
  }

  // Non-advancing = passive closer ("anything else?") OR generic opener ("how
  // can I help?"). Both stall a revenue objective; both trigger the regen gate.
  const replyWasPassiveCloser = isNonAdvancingReply(replyText);
  let passiveCloseRegenerated = false;
  // Wizard→Runtime: a disqualified (poor-fit) prospect may close GRACEFULLY -
  // don't force a forward move on a lead we've configured ourselves to drop.
  const decisionDisqualified = wizardFacts.fit === "disqualified";

  // Committed-action guard (ledger-driven). If a side-effecting action tool
  // actually committed this turn (booking created, lead/contact/deal created,
  // proposal sent), the correct reply is to CONFIRM that outcome per the Action
  // Outcome Contract - NOT to pivot to an earlier objective. The
  // passive-closer/objective regen otherwise classifies a post-booking reply as
  // "non-advancing for GENERATE_LEAD" and rewrites it into a discovery question,
  // so the meeting gets booked on the calendar but the customer is never told
  // (observed live: schedule_meeting ok:true → regen produced "what type of
  // business?"). The Turn Outcome Ledger is the single source of truth for
  // "did a real side effect land" - replacing the old regex scan over tool-result
  // strings, which read whichever result text the model happened to surface.
  const committedActionThisTurn = ledger.committed().length > 0;

  // NOTE: this gate is deliberately NOT subject to budget.exceededTurnCap().
  // The per-turn cap is runaway-protection for unbounded tool loops; these
  // autonomous prompts are large enough that the FIRST generation alone often
  // exceeds it, which would silently disable the quality regen on every turn.
  // The corrective regen is a SINGLE bounded call (guarded by the flag) and is
  // quality-critical, so it runs regardless; conversation/tenant-day caps still
  // protect against abuse at preflight.
  if (
    replyText &&
    !awaitingApproval &&
    !pendingEscalation &&
    replyWasPassiveCloser &&
    !committedActionThisTurn &&
    !customerIsClosing(opts.incomingMessage) &&
    !decisionDisqualified &&
    // Block a passive close when EITHER an active objective forbids it OR the
    // business OUTCOME is still pending/blocked (the case the bare null cursor
    // used to mask: "no next objective" ≠ "the goal happened").
    ((decisionObjStatus && decisionObjStatus.objective.blockPassiveClose) || goalOutcomePending)
  ) {
    console.warn(
      `[ai-bot] passive-closer blocked: ${
        decisionObjStatus
          ? `objective=${decisionObjStatus.objective.id} incomplete (missing=${decisionObjStatus.missingRequired.join(",") || "criteria"})`
          : `goal ${decisionGoalStatus?.outcome}=${decisionGoalStatus?.kind}`
      }. Regenerating.`,
    );
    chatMessages.push({ role: "assistant", content: replyText });
    chatMessages.push({
      role: "user",
      content: (decisionObjStatus
        ? buildCloserCorrective(decisionObjStatus)
        : buildGoalPendingCorrective(decisionGoalStatus!)) + INTERNAL_NUDGE_LANGUAGE_PIN,
    });
    // Regenerate WITHOUT tools so the model must return forward-moving text
    // (a discovery question / next-step proposal), not a half-handled call.
    const regen = await generateResponse({
      tenantId: opts.tenantId,
      sessionId: opts.conversationId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      metadata: { type: "ai_bot_objective_regen", conversationId: opts.conversationId, aiAgentId: config.id },
      signal,
    });
    totalTokens += regen.usage.total_tokens || 0;
    budget.addUsage(regen.usage.total_tokens || 0);
    if (regen.content?.trim()) replyText = regen.content.trim();
    passiveCloseRegenerated = true;
    toolCallLog.push({
      tool: "__objective_gate__",
      args: decisionObjStatus
        ? { objective: decisionObjStatus.objective.id, missing: decisionObjStatus.missingRequired }
        : { goal: decisionGoalStatus?.outcome, status: decisionGoalStatus?.kind },
      result: "regenerated_to_avoid_passive_close",
      decision: "objective_incomplete",
      sideEffect: "objective_gate_regenerated",
    });
  }

  // ── Booking fail-safe gate ──────────────────────────────────────
  // When the agent is NOT bookable, schedule_meeting was never surfaced, so a
  // successful booking is impossible this turn. If the draft reply still
  // commits to a day/time (or implies a booking), regenerate ONCE with a
  // corrective - prompt text alone does not reliably stop this (the Saturday
  // regression). Bookable agents are unaffected; their "claimed booking with no
  // tool" case is covered by the fabricated-action output validator.
  let bookingFailsafeRegenerated = false;
  const bookingCommitment = detectBookingCommitment(replyText);
  if (
    replyText &&
    !awaitingApproval &&
    !pendingEscalation &&
    // Single bounded quality regen - exempt from the per-turn cap (see the
    // passive-closer gate note above).
    !calendarCapability.bookable &&
    bookingCommitment.matched
  ) {
    console.warn(
      `[ai-bot] booking-failsafe blocked: capability=${calendarCapability.capability} ` +
        `committed="${bookingCommitment.phrase}". Regenerating.`,
    );
    chatMessages.push({ role: "assistant", content: replyText });
    chatMessages.push({
      role: "user",
      content: buildBookingFailsafeCorrective(
        calendarCapability.capability === "NO_CALENDAR" ? "no_calendar" : "not_bookable",
      ) + INTERNAL_NUDGE_LANGUAGE_PIN,
    });
    const regen = await generateResponse({
      tenantId: opts.tenantId,
      sessionId: opts.conversationId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      metadata: { type: "ai_bot_booking_failsafe_regen", conversationId: opts.conversationId, aiAgentId: config.id },
      signal,
    });
    totalTokens += regen.usage.total_tokens || 0;
    budget.addUsage(regen.usage.total_tokens || 0);
    if (regen.content?.trim()) replyText = regen.content.trim();
    bookingFailsafeRegenerated = true;
    toolCallLog.push({
      tool: "__booking_failsafe__",
      args: { capability: calendarCapability.capability, committed: bookingCommitment.phrase },
      result: "regenerated_to_avoid_unbookable_commitment",
      decision: "not_bookable",
      sideEffect: "booking_failsafe_regenerated",
    });
  }

  // ── Booking-grounding gate (bookable agents) ────────────────────
  // A bookable agent must never invent calendar truth. Whether a day/time is
  // free, allowed, in the past, or on a non-working day is known ONLY via a
  // `schedule_meeting` call. Any draft that asserts a booking is DONE, agrees
  // to / proposes a concrete time, or STATES availability must be GROUNDED in a
  // schedule_meeting result this turn:
  //   - a "done" claim needs a COMMITTED booking (a real calendar event);
  //   - proposing a time / stating availability is also satisfied by real
  //     proposed slots a schedule_meeting result returned this turn.
  // Observed live (omer): the model invented Saturday availability, accepted a
  // past time (14:00 "today" at 15:15), AND claimed "I booked 14:00" - all with
  // ZERO schedule_meeting calls, so working-hours / min-notice / past-time /
  // freeBusy validation was entirely bypassed and the replies contradicted each
  // other. When ungrounded, regenerate ONCE forcing the tool so its REAL result
  // drives the reply; if the model STILL free-texts an ungrounded time, fall
  // back to a deterministic safe reply (invents nothing). This subsumes the old
  // fabricated-booking guard (a "done" claim is just one assertion kind) and
  // adds the deterministic backstop the LLM-only fallback was missing.
  const bookingClaim = detectBookingClaim(replyText);
  // Kept for the unconfirmed-commit gate below (committed-but-unconfirmed).
  const replyConsistency = evaluateReplyConsistency(ledger, replyText, {
    bookingClaimMatched: bookingClaim.matched,
    replyNonAdvancing: isNonAdvancingReply(replyText),
  });
  // "Grounding" helpers: a committed customer-facing booking, or a
  // schedule_meeting result this turn that returned real proposed alternatives.
  const hasCommittedBooking = () =>
    ledger.customerFacingCommitted().some((e) => e.kind === "booking");
  // Stating availability / proposing a time is GROUNDED by a check_availability
  // result this turn (the read tool is now the source of truth for open slots +
  // working hours), or by a schedule/reschedule result that carried slots.
  const hasProposedSlots = () =>
    toolCallLog.some(
      (c) =>
        (c.tool === "check_availability" || c.tool === "schedule_meeting" || c.tool === "reschedule_meeting") &&
        /proposedSlotsIso|workingHours|requestedAvailable|nextAvailableIso/.test(
          typeof c.result === "string" ? c.result : "",
        ),
    );
  const ungroundedAssertion = (reply: string | null) =>
    isBookingAssertionUngrounded(detectBookingAssertion(reply), {
      committedBooking: hasCommittedBooking(),
      proposedSlots: hasProposedSlots(),
    });

  // A successful cancel this turn GROUNDS any meeting mention in the reply (it's
  // a cancellation confirmation, not a booking claim). Without this the grounding
  // gate flagged "ביטלתי את הפגישה" as an ungrounded booking assertion and
  // regenerated it into a bogus "let's schedule a meeting, when's good?" reply.
  const cancelledThisTurn = toolCallLog.some(
    (c) => c.tool === "cancel_meeting" && TOOL_OK_RE.test(typeof c.result === "string" ? c.result : ""),
  );
  let bookingGroundingRegenerated = false;
  const assertion = detectBookingAssertion(replyText);
  if (
    replyText &&
    !awaitingApproval &&
    !pendingEscalation &&
    !cancelledThisTurn &&
    calendarCapability.bookable &&
    ungroundedAssertion(replyText)
  ) {
    console.warn(
      `[ai-bot] booking-grounding blocked: reply asserts ${assertion.kind} ("${assertion.phrase}") ` +
        `with no schedule_meeting grounding this turn. Regenerating with tools.`,
    );
    chatMessages.push({ role: "assistant", content: replyText });
    chatMessages.push({ role: "user", content: buildBookingGroundingCorrective() + INTERNAL_NUDGE_LANGUAGE_PIN });
    const regen = await generateResponse({
      tenantId: opts.tenantId,
      sessionId: opts.conversationId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      tools: tools as any[],
      metadata: { type: "ai_bot_booking_grounding_regen", conversationId: opts.conversationId, aiAgentId: config.id },
      signal,
    });
    totalTokens += regen.usage.total_tokens || 0;
    budget.addUsage(regen.usage.total_tokens || 0);
    const regenToolCalls = regen.toolCalls;
    if (regenToolCalls && regenToolCalls.length > 0) {
      chatMessages.push({ role: "assistant", content: regen.content || "", tool_calls: regenToolCalls });
      for (const tc of regenToolCalls) {
        const toolName = tc.function?.name || "unknown";
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        // This regen exists to GROUND a booking claim, not to hand off. If the
        // model grabs the always-present escalate_to_human here it's an
        // off-purpose artifact (observed live: a stray escalation executed during
        // grounding). Acknowledge the tool_call so the message sequence stays
        // valid, but do NOT dispatch the escalation side effect.
        if (toolName === "escalate_to_human") {
          console.warn(`[ai-bot] booking-grounding: ignoring off-purpose escalate_to_human. convo=${opts.conversationId}`);
          chatMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: "escalation_not_applicable_during_booking_grounding" }),
          });
          continue;
        }
        const exec = await getActionOrchestrator().submit(
          {
            id: randomUUID(),
            conversationId: agentToolCtx.conversationId ?? "",
            tenantId: agentToolCtx.tenantId,
            proposedBy: { mode: "chat", system: "ai-bot:booking-grounding" },
            actor: { agentId: "" },
            tool: toolName,
            args: toolArgs,
            rationale: "ai-bot booking-grounding forced tool call",
            urgency: "low",
          },
          () =>
            dispatchToolCall(
              { id: tc.id, function: { name: toolName, arguments: tc.function?.arguments || "{}" } },
              agentToolCtx,
            ),
          { ledger, ctx: ledgerCtx, idempotency: true },
        );
        const result = unwrapToolExec(tc.id, toolName, exec);
        toolCallLog.push({ tool: toolName, args: toolArgs, result: result.content, decision: "executed_on_retry", sideEffect: undefined });
        chatMessages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
      }
      const finalResp = await generateResponse({
        tenantId: opts.tenantId,
        sessionId: opts.conversationId,
        model,
        messages: chatMessages,
        temperature: config.temperature ?? 0.7,
        maxTokens: config.maxTokens ?? 1024,
        tools: tools as any[],
        metadata: { type: "ai_bot_booking_grounding_final", conversationId: opts.conversationId, aiAgentId: config.id },
        signal,
      });
      totalTokens += finalResp.usage.total_tokens || 0;
      budget.addUsage(finalResp.usage.total_tokens || 0);
      if (finalResp.content?.trim()) replyText = finalResp.content.trim();
    } else if (regen.content?.trim()) {
      replyText = regen.content.trim();
    }
    bookingGroundingRegenerated = true;

    // Deterministic backstop. If the regenerated reply STILL asserts an
    // ungrounded time/availability/booking (the model refused the tool and kept
    // free-texting - exactly what bit omer), strip it to a safe reply that
    // invents nothing rather than ship the lie. Never trust a second LLM pass to
    // self-correct a fabrication.
    const postAssertion = detectBookingAssertion(replyText);
    if (ungroundedAssertion(replyText)) {
      const isHe = /[֐-׿]/.test(replyText || opts.incomingMessage || "");
      console.warn(
        `[ai-bot] booking-grounding fallback: reply still asserts ${postAssertion.kind} ` +
          `("${postAssertion.phrase}") with no grounding after regen - using deterministic safe reply.`,
      );
      replyText = buildBookingGroundingFallback(isHe);
    }
    toolCallLog.push({
      tool: "__booking_grounding_gate__",
      args: { asserted: assertion.kind, phrase: assertion.phrase },
      result: "regenerated_to_ground_booking_statement",
      decision: "booking_ungrounded",
      sideEffect: "booking_grounding_regenerated",
    });
  }

  // ── Ledger consistency gate: unconfirmed commit ─────────────────
  // A customer-facing outcome (e.g. a booking) ACTUALLY committed this turn but
  // the draft reply fails to confirm it (empty / passive closer) - the meeting
  // is on the calendar yet the customer would be told nothing, or asked an
  // unrelated discovery question. The committed-summary block is already in
  // context (injected mid-loop); push the stronger corrective and regenerate
  // ONCE WITHOUT tools so the reply is derived from the committed ledger state.
  // Skipped when the fabricated-booking guard already regenerated this turn.
  let unconfirmedCommitRegenerated = false;
  if (
    !bookingGroundingRegenerated &&
    !awaitingApproval &&
    !pendingEscalation &&
    replyConsistency.status === "unconfirmed_commit"
  ) {
    const kinds = replyConsistency.customerFacing.map((e) => e.kind);
    console.warn(
      `[ai-bot] unconfirmed-commit blocked: ledger committed customer-facing ${kinds.join(",")} ` +
        `but the draft reply does not confirm it. Regenerating from ledger state.`,
    );
    injectCommittedSummaryIfNeeded();
    injectOutcomeFacts();
    if (replyText) chatMessages.push({ role: "assistant", content: replyText });
    chatMessages.push({ role: "user", content: buildUnconfirmedCommitCorrective(kinds) + INTERNAL_NUDGE_LANGUAGE_PIN });
    const regen = await generateResponse({
      tenantId: opts.tenantId,
      sessionId: opts.conversationId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      metadata: { type: "ai_bot_unconfirmed_commit_regen", conversationId: opts.conversationId, aiAgentId: config.id },
      signal,
    });
    totalTokens += regen.usage.total_tokens || 0;
    budget.addUsage(regen.usage.total_tokens || 0);
    if (regen.content?.trim()) replyText = regen.content.trim();
    unconfirmedCommitRegenerated = true;
    toolCallLog.push({
      tool: "__ledger_consistency_gate__",
      args: { committed: kinds },
      result: "regenerated_to_confirm_committed_outcome",
      decision: "unconfirmed_commit",
      sideEffect: "unconfirmed_commit_regenerated",
    });
  }

  // ── Redundant info-request gate ─────────────────────────────────
  // The customer just gave an email/phone/time but the draft re-asks for it.
  // Prompt rules don't reliably stop this; regenerate once to confirm + advance.
  let redundantContactRegenerated = false;
  const redundantInfo = detectRedundantInfoRequest(opts.incomingMessage, replyText);
  if (
    replyText &&
    !awaitingApproval &&
    !pendingEscalation &&
    redundantInfo.matched
  ) {
    console.warn(
      `[ai-bot] redundant-info blocked: customer already provided ${redundantInfo.items.join("+")}. Regenerating.`,
    );
    chatMessages.push({ role: "assistant", content: replyText });
    chatMessages.push({ role: "user", content: buildRedundantInfoCorrective(redundantInfo.items) });
    const regen = await generateResponse({
      tenantId: opts.tenantId,
      sessionId: opts.conversationId,
      model,
      messages: chatMessages,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 1024,
      metadata: { type: "ai_bot_redundant_info_regen", conversationId: opts.conversationId, aiAgentId: config.id },
      signal,
    });
    totalTokens += regen.usage.total_tokens || 0;
    budget.addUsage(regen.usage.total_tokens || 0);
    if (regen.content?.trim()) replyText = regen.content.trim();
    redundantContactRegenerated = true;
    toolCallLog.push({
      tool: "__redundant_info__",
      args: { provided: redundantInfo.items },
      result: "regenerated_to_avoid_reasking_provided_info",
      decision: "already_provided",
      sideEffect: "redundant_info_regenerated",
    });
  }

  // NOTE: a self-repetition regen gate was tried here and REMOVED - pushing the
  // model off a near-duplicate reply made it over-correct into giving up /
  // escalating ("I'll transfer you to the team"), which is far worse than a
  // mildly repetitive but on-track reply. Repetition is handled softly by the
  // QUALITY_CONTRACT instead; do not reintroduce a hard regen for it.

  // ── Action-honesty signal ───────────────────────────────────────
  // Flag replies that CLAIM work is in progress / done / coming when no tool
  // executed this turn (the 2026-07-21 incident: "אני בודקת עכשיו... הנה 3
  // אופציות" across 14 turns, ZERO tool calls). Detection + audit only for now
  // - a hard reply-rewrite here risks the over-correction the self-repetition
  // gate above was removed for; the deterministic block is a reviewed follow-up.
  // ── Customer Outcome Contract ───────────────────────────────────
  // The primary check, and the one that asks the right question. The regex net
  // below asks "did ANY tool run", so reading an order was evidence for "I
  // changed your address" - the claim and the evidence were never about the
  // same thing. Here each claim is checked against the facts that claim is
  // about, and the facts come from tools that verified themselves by reading
  // back. A paraphrase nobody has seen still fails, because facts do not change
  // when wording does.
  try {
    const outcome = buildOutcome(toolCallLog);
    const verdict = validateOutcomeClaims(replyText, outcome);
    if (!verdict.ok) {
      console.warn(
        `[ai-bot] OUTCOME-CONTRACT: reply claims ${verdict.unsupported.map((u) => u.claim).join(",")} ` +
          `that the turn's facts do not support conv=${opts.conversationId}`,
      );
      prisma.auditLog
        .create({
          data: {
            tenantId: opts.tenantId,
            actorType: "ai",
            action: "ai.unsupported_outcome_claim",
            targetType: "conversation",
            targetId: opts.conversationId,
            metadata: {
              claims: verdict.unsupported.map((u) => u.claim),
              matched: verdict.unsupported.map((u) => u.match).slice(0, 4),
              requires: verdict.unsupported.map((u) => u.requires).slice(0, 4),
              toolsThisTurn: toolCallLog.map((t) => t.tool).filter(Boolean),
              source: "ai_bot",
            } as any,
          },
        })
        .catch((err: any) => console.error("[ai-bot] outcome audit failed:", err?.message));

      const cleaned = stripUnsupportedClaims(replyText, verdict);
      if (cleaned) {
        console.warn(`[ai-bot] OUTCOME-CONTRACT: removed unsupported claim(s) conv=${opts.conversationId}`);
        replyText = cleaned;
      }
    }

    // A reply that is ONLY a promise to go and look is the silent turn wearing
    // a sentence. Live: "רגע אחת, בודקת את מצב המשלוח של הזמנה 1002" was the
    // entire answer to "where is my shipment", and no second message exists to
    // follow it. Blanked here so the silent-turn fallback offers something the
    // customer can act on instead of a wait with no end.
    if (isInterimOnlyReply(replyText)) {
      console.error(
        `[ai-bot] INTERIM-ONLY reply with no finding conv=${opts.conversationId} - ` +
          `tools=${toolCallLog.map((t) => t.tool).filter(Boolean).join(",") || "none"}`,
      );
      replyText = null;
    }
  } catch (err: any) {
    console.warn("[ai-bot] outcome contract check failed:", err?.message);
  }

  try {
    const honesty = validateActionHonesty(replyText, toolCallLog, {
      // An approval IS a real background job: the system guarantees exactly one
      // continuation once it is decided, so "I will update you" is a promise
      // the product actually keeps here.
      hasBackgroundJob: toolCallLog.some((t: any) => t?.sideEffect === "awaiting_approval"),
    });
    if (!honesty.ok) {
      console.warn(
        `[ai-bot] ACTION-HONESTY: reply claims ${honesty.unsupported.map((c) => c.kind).join(",")} ` +
          `with no execution evidence conv=${opts.conversationId}`,
      );
      prisma.auditLog
        .create({
          data: {
            tenantId: opts.tenantId,
            actorType: "ai",
            action: "ai.unsupported_action_claim",
            targetType: "conversation",
            targetId: opts.conversationId,
            metadata: {
              claims: honesty.unsupported.map((c) => c.kind),
              matched: honesty.unsupported.map((c) => c.match).slice(0, 4),
              toolsThisTurn: toolCallLog.map((t) => t.tool).filter(Boolean),
              source: "ai_bot",
            } as any,
          },
        })
        .catch((err: any) => console.error("[ai-bot] honesty audit failed:", err?.message));

      // ENFORCE the one shape that must not ship. A "we've passed this to the
      // team" with nothing behind it reads as resolution: the customer stops
      // chasing and no one is coming. The other shapes stay observe-only,
      // where a false positive would cost more than it saves.
      if (honesty.unsupported.some((c) => c.kind === "delegated" || c.kind === "performed" || c.kind === "followup")) {
        const cleaned = stripUnsupportedDelegation(replyText);
        if (cleaned) {
          console.warn(`[ai-bot] ACTION-HONESTY: removed an unsupported delegation claim conv=${opts.conversationId}`);
          replyText = cleaned;
        }
      }
    }
  } catch (err: any) {
    console.warn("[ai-bot] action-honesty check failed:", err?.message);
  }

  // ── Outbound credential check ───────────────────────────────────
  // The adapter already redacts on the way IN, so anything found here escaped
  // that and was either invented by the model or carried by a path that does
  // not go through executeAdapterTool. Either way it must not ship: an
  // `authenticate?key=` link is a bearer credential for the customer's own
  // order page, and once it is in a transcript it belongs to everyone who
  // later reads the transcript. Redact and shout - the interesting fact is
  // which reply managed it.
  try {
    if (containsPrivateShopifyData(replyText)) {
      console.error(
        `[ai-bot] SECURITY: outbound reply carried a private Shopify URL or token conv=${opts.conversationId}`,
      );
      prisma.auditLog
        .create({
          data: {
            tenantId: opts.tenantId,
            actorType: "ai",
            action: "security.private_url_in_reply",
            targetType: "conversation",
            targetId: opts.conversationId,
            metadata: { source: "ai_bot" } as any,
          },
        })
        .catch((err: any) => console.error("[ai-bot] leak audit failed:", err?.message));
      replyText = redactString(replyText ?? "");
    }
  } catch (err: any) {
    console.warn("[ai-bot] outbound credential check failed:", err?.message);
  }

  // ── Conversation decision trace ─────────────────────────────────
  // One structured line per generation so live tests can validate exactly
  // which role/skill/objective drove the reply and what was still missing.
  // Grep with: docker compose logs -f ai | grep decision-trace
  try {
    const knowledgeMissing = computeKnowledgeLedger(
      requiredKnowledgeFor(config.role),
      decisionFactText,
    ).entries.filter((e) => !e.known && e.importance === "required").map((e) => e.key);
    console.log(
      "[ai-bot][decision-trace] " +
        JSON.stringify({
          conversationId: opts.conversationId,
          agentId: config.id,
          agentName: config.name,
          role: config.role,
          skill: roleToSkill(config.role),
          strategy: behaviorState.strategy,
          prospectState: decisionProspectState,
          activeObjective: decisionObjStatus?.objective.id ?? "ALL_COMPLETE",
          objectiveStep: decisionObjStatus
            ? `${decisionObjStatus.stepIndex + 1}/${decisionObjStatus.chain.length}`
            : "-",
          objectiveMissing: decisionObjStatus?.missingRequired ?? [],
          knowledgeMissing,
          replyWasPassiveCloser,
          passiveCloseRegenerated,
          calendarCapability: calendarCapability.capability,
          bookingFailsafeRegenerated,
          redundantContactRegenerated,
          finalReplyPassiveCloser: isNonAdvancingReply(replyText),
          awaitingApproval: !!awaitingApproval,
          escalated: !!pendingEscalation,
        }),
    );
  } catch (err: any) {
    console.warn("[ai-bot] decision-trace log failed:", err?.message);
  }

  // Audit - full BehaviorState + tool calls.
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
        // WHY the turn escalated - machine case + human summary, so the owner
        // UI can explain the handover instead of showing a bare flag.
        escalationReason: pendingEscalation?.reason ?? undefined,
        escalationSummary: pendingEscalation?.summary ?? undefined,
        awaitingApproval: !!awaitingApproval,
        // GOAL OWNERSHIP (Unit A): the committed goal carried to the next turn.
        activeGoal: nextGoalSnapshot ?? undefined,
        // WIZARD→RUNTIME: the structured judgment facts that drove this turn.
        wizardFacts: wizardFacts.evaluated ? wizardFacts : undefined,
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
  // in tryEmit + try/catch - never throws into the hot path.
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

  // Escalation must not leave the customer in silence. If we handed off to a
  // human (escalate_to_human) but the model produced no customer-facing text,
  // send a short warm transition line so they know a person is taking over.
  if (pendingEscalation && !replyText?.trim()) {
    const he = /[֐-׿]/.test(opts.incomingMessage || "");
    replyText = he
      ? "העברתי את זה לצוות שלנו, מישהו מאיתנו יחזור אליך בהקדם 🙏"
      : "I've passed this on to our team, someone will get back to you shortly 🙏";
  }

  // ── Deterministic grounded product rendering (ISOLATED) ─────────────────
  // A Shopify product search ran this turn: the exact product identity (title,
  // price, currency, availability, URL) comes from the canonical envelope, not
  // the model's prose. The model referenced candidates by PRODUCT_n; the
  // renderer resolves them, blocks invented refs, and strips any URL/price the
  // model tried to emit. On any failure it still renders from the canonical
  // envelope (never generic model inventory) and logs loudly.
  if (productEnvelope) {
    // Does this channel have somewhere better to put products than a
    // sentence? The capability map answers, not this file.
    const recoCaps = capabilitiesFor(conversation.channel as string);
    const channelSupportsCards = recoCaps.supportsProductCarousel || recoCaps.supportsCards;
    const canStage = !!shopifyTurn?.sendShopifyProducts;

    const recoPlan = planAutoRecommendation({
      envelope: productEnvelope,
      // Staging is Shopify Live Chat's mechanism. A channel that renders
      // cards but has no staging path (web chat today) still takes the
      // text route, honestly.
      channelSupportsCards: channelSupportsCards && canStage,
      alreadyStaged: (shopifyTurn?.staged.length ?? 0) > 0,
      modelText: replyText,
      locale: replyLocale,
      budget: productBudget,
      maxProducts: recoCaps.maxCards ?? MAX_CAROUSEL_ITEMS,
    });

    let structuredSent = false;
    if (recoPlan.shouldSendStructured) {
      // Promote by calling the SAME staging function the model should
      // have called: it re-resolves every product against Shopify, drops
      // unpublished ones and enforces this channel's store binding, so
      // the automatic path inherits every guarantee the tool path has.
      try {
        const staged = await shopifyTurn!.sendShopifyProducts!({
          products: recoPlan.selected.map((c) => ({
            productId: c.productId,
            variantId: c.variantId,
            reason: reasonForCandidate(c, productBudget, replyLocale),
          })),
        });
        if (staged.ok) {
          structuredSent = true;
        } else {
          reportCarouselFallback({
            conversationId: opts.conversationId,
            tenantId: opts.tenantId,
            reason: `stage_refused:${staged.reason ?? "unknown"}`,
            productCount: recoPlan.selected.length,
          });
        }
      } catch (err: any) {
        reportCarouselFallback({
          conversationId: opts.conversationId,
          tenantId: opts.tenantId,
          reason: `stage_threw:${err?.message ?? "unknown"}`,
          productCount: recoPlan.selected.length,
        });
      }
    }

    if (structuredSent || recoPlan.skipReason === "already_staged") {
      // The products are in the cards. The text is a lead-in and nothing
      // else - no numbered list, no URLs, no "shall I send a card?".
      replyText = recoPlan.introduction;
    } else {
      // Genuine fallback: this channel cannot render cards, or staging
      // failed. The legacy deterministic renderer is exactly right here,
      // and it stays untouched so WhatsApp behaviour does not move.
      try {
        const rendered = renderGroundedProductReply(replyText, productEnvelope, replyLocale);
        if (rendered.blocked.length) {
          console.warn(`[ai-bot] grounded render blocked invented product refs: ${rendered.blocked.join(",")} conv=${opts.conversationId}`);
        }
        if (rendered.usedFallback) {
          console.warn(`[ai-bot] grounded render used deterministic fallback (canonical envelope) conv=${opts.conversationId}`);
        }
        replyText = rendered.message;
      } catch (err: any) {
        console.error(`[ai-bot] grounded render FAILED, falling back to canonical list conv=${opts.conversationId}:`, err?.message);
        try { replyText = renderCandidatesForWhatsApp(productEnvelope, replyLocale); } catch { /* keep model reply */ }
      }
    }
  }

  // Final humanizing pass on the outgoing reply (strip machine-style dashes).
  replyText = humanizeReply(replyText);

  // Deterministic guard: internal narration and unbacked promises.
  //
  // The prompt already forbids both, and on 2026-07-31 the model did both
  // anyway to a live customer - narrating tool names, counting its own checks,
  // surfacing a provider error, and promising four times to contact a shipping
  // team it cannot reach and to send updates it never scheduled.
  //
  // Evidence comes from the turn's COMMITTED ledger, not from "a tool returned
  // ok": `update_order_fulfillment` succeeding means a note was written on the
  // order, which is not the same as anyone being told. A promise with no
  // matching committed action is removed rather than sent.
  if (replyText) {
    try {
      const guarded = guardCustomerReply(replyText, {
        locale: replyLocale,
        invokedTools: toolCallLog.map((t) => t.tool),
        evidence: turnEvidenceFrom(
          ledger.committed().map((e) => e.tool),
          { escalated: !!awaitingApproval },
        ),
      });
      if (guarded.changed) {
        console.warn(
          `[ai-bot] reply guard rewrote the outgoing message conv=${opts.conversationId}: ` +
            guarded.findings.map((f) => `${f.kind}(${f.match})`).join(", "),
        );
        replyText = guarded.text;
      }
    } catch (err: any) {
      // A guard that throws must not cost the customer their reply.
      console.error(`[ai-bot] reply guard failed conv=${opts.conversationId}:`, err?.message);
    }
  }

  // Grammatical agreement check.
  //
  // Reports, deliberately does not rewrite. Hebrew agreement cannot be
  // repaired by pattern substitution without producing something worse
  // than the mistake, and a wrong form is a quality failure, not a false
  // statement about the customer's order - so it must never cost anyone
  // their reply. What it buys is visibility: a conflict here means the
  // model ignored a form the customer gave us THIS conversation, which is
  // the exact regression the address block exists to prevent and the only
  // way to know it is happening at all.
  if (replyText && ctxSlot.grammaticalAddress) {
    try {
      const verdict = validateGrammaticalAgreement(
        replyText,
        ctxSlot.grammaticalAddress,
        addressLocale,
      );
      if (shouldRegenerateForAddress(verdict)) {
        console.warn(
          `[ai-bot] grammatical address mismatch conv=${opts.conversationId} ` +
            `known=${ctxSlot.grammaticalAddress.form}/${ctxSlot.grammaticalAddress.confidence} ` +
            `reply=${verdict.replyForm} problems=${verdict.problems.join(",")}`,
        );
      }
    } catch (err: any) {
      console.error(`[ai-bot] grammatical check failed conv=${opts.conversationId}:`, err?.message);
    }
  }

  // Output validator - last defence against prompt-leakage and fabricated
  // execution claims ("I refunded your card" with no refund tool call).
  // Fire-and-forget audit on any violation; returns a safe deflection in
  // the same language. Skipped when we're handing off (approval / escalation).
  const safeReply = awaitingApproval
    ? null
    : await validateAndPersist(replyText, {
        tenantId: opts.tenantId,
        conversationId: opts.conversationId,
        toolCallLog,
        // Ledger is the single source of truth for committed actions - feed it
        // to the fabrication check so a deduped/cross-turn commit isn't flagged.
        ledgerCommittedTools: ledger.committed().map((e) => e.tool),
      });

  // Don't emit an interim ack that is identical to the final reply (avoids a
  // duplicate bubble if the model didn't actually produce a distinct result).
  const finalInterim = interimMessages.filter((m) => m && m !== safeReply);

  // Record any product search this turn into Discovery State (attempt +
  // shown product ids) for reshow-dedup and an auditable discovery history.
  // Fire-and-forget - never delays or breaks the reply.
  void recordDiscoverySearchOutcome({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    aiAgentId: opts.aiAgentId,
    toolCallLog,
  });

  // Silence is not an outcome.
  //
  // A turn can end with no text at all: the model spends its round on tool
  // calls and returns nothing, and every guard downstream is happy because
  // there is nothing to object to. The customer asked a question and got no
  // reply - not an error, not a handoff, nothing. Part 4 recorded this once
  // (a turn that read one order produced no reply, silently) and fixed the
  // payload that caused it; it recurred here on a different pair of reads,
  // which says the shape of the fix was too specific.
  //
  // An escalation or an approval pause is a different case: both already owe
  // the customer a message from another path, and adding one here would make
  // two.
  const deliverable =
    safeReply?.trim() ||
    (pendingEscalation || awaitingApproval
      ? safeReply
      : silentTurnFallback(replyLocale));
  if (!safeReply?.trim() && !pendingEscalation && !awaitingApproval) {
    console.error(
      `[ai-bot] SILENT TURN: no reply produced conv=${opts.conversationId} ` +
        `tools=${toolCallLog.map((t) => t.tool).join(",") || "none"} - sent the fallback instead of nothing`,
    );
  }

  return {
    reply: deliverable,
    interimMessages: finalInterim.length > 0 ? finalInterim : undefined,
    escalation: pendingEscalation,
    awaitingApproval,
    toolCallLog,
    knowledgeUsed,
    toolsOffered,
    modelUsed: model,
    totalTokens,
    // Only ship staged cards when there is a reply to attach them to. On
    // an escalation or an approval pause the customer is being handed
    // over, and a product card arriving after "let me get a colleague"
    // would be noise.
    structuredMessages:
      safeReply && shopifyTurn?.staged.length ? shopifyTurn.staged : undefined,
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
    return { reply: null, modelUsed: config.model || getDefaultModel(), totalTokens: 0 };
  }

  const oneshotState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
    request: { lastMessage: opts.userInput, messageCount: 1 },
  });

  // Even one-shot replies represent the company - inherit its identity.
  const oneshotCompany = await getCompanyContext(opts.tenantId);

  const systemPrompt = buildAgentPrompt({
    behaviorState: oneshotState,
    agent: toAgentRecord(config),
    company: oneshotCompany ?? undefined,
  });

  const model = config.model || getDefaultModel();
  const maxTokens = opts.maxTokens ?? Math.min(config.maxTokens ?? 1024, 400);

  const result = await generateResponse({
    tenantId: opts.tenantId,
    // One-shot replies have no conversation - pin to the agent so repeat
    // one-shots from the same agent (comment replies, smart-tasks, etc.)
    // share a cache routing key when the system prompt is stable.
    sessionId: `ai-agent:${config.id}`,
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
    // Style layer applies HERE, not only in the callers that remembered.
    // The approval acknowledgement goes out through this endpoint and skipped
    // it, so a customer was greeted with "קיבלתי — אני מטפלת בביטול" - an
    // em dash, which the quality contract forbids precisely because it reads
    // as machine-written. Every one-shot is customer-facing somewhere.
    reply: humanizeReply(result.content ?? null),
    modelUsed: model,
    totalTokens: result.usage.total_tokens || 0,
  };
}

/**
 * Post-execution customer message - the ONE path for telling a customer what
 * a verified tool execution actually did (approval continuations, proactive
 * completion updates). Generation goes through the same humanizeReply style
 * layer as live bot replies, then a deterministic grounding validator; if the
 * generated text contradicts or omits a verified fact (wrong amount, pending
 * presented as done, success on a failure, em-dash), we send the boring
 * template built directly from the structured result instead. This function
 * never returns an ungrounded message.
 */
export async function generateExecutionMessage(opts: {
  tenantId: string;
  aiAgentId: string;
  facts: ExecutionFacts;
  /** Recent inbound customer text, oldest→newest - drives language choice. */
  inboundSample: string;
  customerName?: string;
}): Promise<{ reply: string; grounded: boolean; modelUsed: string }> {
  const { facts } = opts;
  try {
    const userInput =
      `[INTERNAL CONTEXT - do not echo to the customer]\n` +
      `A background action you triggered (${facts.tool}) finished with outcome=${facts.outcome}.\n` +
      `VERIFIED FACTS (the ONLY facts you may state - never invent amounts, dates, statuses):\n` +
      JSON.stringify({
        order: facts.orderName ?? undefined,
        amount: facts.amount ?? undefined,
        currency: facts.currency ?? undefined,
        status: facts.status ?? undefined,
        reference: facts.reference ?? undefined,
        // The PHRASE, never the internal class. Handing the model
        // `failure_reason: "unknown"` is how a live customer was told
        // "(סיבה: unknown)" - it dutifully printed the token we gave it.
        failure_reason:
          facts.outcome === "failed"
            ? reasonPhrase(facts.errorReason, HEBREW_RE.test(opts.inboundSample)) || undefined
            : undefined,
      }) + "\n" +
      `Customer's recent messages (oldest → newest):\n${opts.inboundSample}\n` +
      (opts.customerName ? `Customer name: ${opts.customerName}\n` : "") +
      `\nTASK: ONE short reply telling the customer the outcome and the next step.\n` +
      `Rules:\n` +
      `- Reply in the customer's language (Hebrew if any message contains Hebrew characters).\n` +
      `- State amounts/currency/order EXACTLY as given in VERIFIED FACTS.\n` +
      `- status "pending" means the money has NOT moved yet - say it was submitted and is pending, never that it completed.\n` +
      `- outcome "failed" must never be presented as success; do not promise a specific fix.\n` +
      `- outcome "rejected" means a person DECLINED the request: nothing was attempted and nothing is broken. Say plainly it was not approved, say the order/money is therefore unchanged, and offer to look at alternatives. Never blame a technical problem, and never say you are "working on it".\n` +
      `- Never claim a colleague, team or courier was contacted, or that someone will get back to them, unless that is stated in VERIFIED FACTS.\n` +
      // Live (2026-08-02): an order-confirmation send failed, and the
      // continuation asked the customer which email address to use. The
      // request would have been refused anyway - the guard denies a chat-
      // supplied destination for a financial document outright - so the
      // question could only ever waste the customer's time and teach them the
      // system works in a way it does not.
      `- NEVER ask the customer where to send a document, invoice, receipt or confirmation. Those go only to the address already on their account; an address typed in chat is refused by the system, so asking for one is asking for something that cannot be used.\n` +
      // Live (2026-08-02): a return failed with "that GraphQL field does not
      // exist" and the customer was told it failed "because the order has
      // already been handed to shipping" - a specific, plausible and invented
      // cause. A failure whose reason we do not have is a failure, full stop.
      `- Do NOT invent a CAUSE for a failure. If failure_reason is absent, say it did not go through and stop; never supply a plausible-sounding explanation of your own.\n` +
      // A return was opened correctly, read back correctly, and announced with
      // no reference in it. True, and less than the customer needed.
      `- When VERIFIED FACTS carry a `+"`reference`"+`, quote it exactly. It is what the customer needs to ask about this later.\n` +
      `- No em dashes, no headings, no bullet lists, no "I'm happy to assist" filler.\n` +
      `- Do NOT mention internal systems or approvals.\n`;
    const r = await generateAIBotOneshot({
      tenantId: opts.tenantId,
      aiAgentId: opts.aiAgentId,
      userInput,
      feature: "post_execution_message",
    });
    const styled = humanizeReply(r.reply);
    if (styled) {
      const verdict = validateGroundedMessage(styled, facts);
      if (verdict.ok) return { reply: styled, grounded: true, modelUsed: r.modelUsed };
      console.warn(
        `[ai-bot] execution message failed grounding (${verdict.problems.join(",")}) - using deterministic fallback`,
      );
    }
  } catch (err: any) {
    console.warn("[ai-bot] execution message generation failed - using deterministic fallback:", err?.message);
  }
  return {
    reply: buildFallbackMessage(facts, opts.inboundSample),
    grounded: false,
    modelUsed: "deterministic-fallback",
  };
}

// ─── Follow-up flow facts (WhatsApp window + templates) ──────

const HEBREW_RE = /[֐-׿]/;

function detectLocale(samples: string[]): "he" | "en" {
  // Lightweight detector - any Hebrew chars in recent customer messages
  // flips locale to Hebrew. This is what the prompt-builder reads when
  // deciding which language to render its "STRICT" blocks in.
  for (const s of samples) {
    if (s && HEBREW_RE.test(s)) return "he";
  }
  return "en";
}

interface FollowupFlowFacts {
  whatsappWindowBlock?: string;
  templatesBlock?: string;
}

/**
 * Loads two facts the bot needs to drive the follow-up decision tree:
 *
 *   1. WhatsApp 24h customer-service window - when did the customer last
 *      send an INBOUND message? If > 24h, free-text follow-ups are silently
 *      dropped by Meta and the bot must use a template path instead.
 *
 *   2. The tenant's approved WhatsApp templates (per channel + language)
 *      so the bot can pick a valid template_name when scheduling outside
 *      the 24h window.
 *
 * Best-effort: any DB error returns an empty block so the prompt just
 * lacks the fact, rather than blowing up the bot turn.
 */
async function loadFollowupFlowFacts(args: {
  tenantId: string;
  conversation: any;
  locale: "he" | "en";
}): Promise<FollowupFlowFacts> {
  const out: FollowupFlowFacts = {};

  try {
    // Latest inbound message timestamp for the 24h-window calculation.
    const lastInbound = await prisma.message.findFirst({
      where: {
        tenantId: args.tenantId,
        conversationId: args.conversation.id,
        direction: "INBOUND" as any,
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const now = new Date();
    const channel = String(args.conversation.channel || "").toUpperCase();
    const isWhatsApp = channel === "WHATSAPP";

    let secondsSinceLastInbound: number | null = null;
    let windowOpen = false;
    let windowExpiresAt: Date | null = null;
    if (lastInbound) {
      secondsSinceLastInbound = Math.floor((now.getTime() - lastInbound.createdAt.getTime()) / 1000);
      windowOpen = secondsSinceLastInbound < 24 * 3600;
      windowExpiresAt = new Date(lastInbound.createdAt.getTime() + 24 * 3600 * 1000);
    }

    const lines: string[] = ["## WhatsApp customer-service window"];
    lines.push(`- conversation_channel: ${channel || "unknown"}`);
    if (isWhatsApp) {
      if (secondsSinceLastInbound === null) {
        lines.push("- no inbound messages yet - window is CLOSED by default; template path required to first-contact");
      } else {
        const hh = Math.floor(secondsSinceLastInbound / 3600);
        const mm = Math.floor((secondsSinceLastInbound % 3600) / 60);
        lines.push(`- seconds_since_last_inbound: ${secondsSinceLastInbound} (≈ ${hh}h ${mm}m ago)`);
        lines.push(`- 24h_window_open: ${windowOpen}`);
        if (windowExpiresAt) lines.push(`- 24h_window_expires_at: ${windowExpiresAt.toISOString()}`);
        lines.push(
          windowOpen
            ? "- DECISION: if your scheduled send_at_iso is BEFORE 24h_window_expires_at → free-text `schedule_followup` is fine. Otherwise use `schedule_followup_template`."
            : "- DECISION: window is CLOSED. Any follow-up MUST use `schedule_followup_template` (a free-text send will be silently dropped by Meta).",
        );
      }
    } else {
      lines.push(
        "- DECISION: conversation is NOT on WhatsApp. To follow up reliably, ask for a WhatsApp number, call `link_customer_identifier` to attach it, then schedule via `schedule_followup_template`.",
      );
    }
    out.whatsappWindowBlock = lines.join("\n");
  } catch (err: any) {
    console.warn("[ai-bot] loadFollowupFlowFacts window:", err?.message);
  }

  try {
    // Tenant's approved WhatsApp templates. Filter to active + approved
    // (or pending) so the bot only suggests templates that will actually
    // send. Cap to 20 entries to keep the prompt small.
    const channel = String(args.conversation.channel || "").toUpperCase();
    const templates = await (prisma as any).messageTemplate.findMany({
      where: {
        tenantId: args.tenantId,
        isActive: true,
        status: "APPROVED",
        OR: [{ channel: "WHATSAPP" }, { channel: null }],
      },
      select: { name: true, language: true, body: true, variables: true, buttons: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }).catch(() => []);
    if (Array.isArray(templates) && templates.length > 0) {
      const lines: string[] = [
        "## Approved WhatsApp templates (use template_name verbatim with schedule_followup_template)",
        "Meta only substitutes POSITIONAL placeholders ({{1}}, {{2}}, …). The `variables` arg you pass to schedule_followup_template MUST be a map keyed by those numbers (e.g. {\"1\": \"עומר\", \"2\": \"17.05.2026\"}). Use the per-placeholder description below to decide what value goes in each slot.",
      ];
      for (const t of templates) {
        const preview = String(t.body || "").replace(/\s+/g, " ").slice(0, 140);
        lines.push("");
        lines.push(`- name="${t.name}" lang=${t.language || "?"}`);
        lines.push(`  body: ${JSON.stringify(preview)}`);
        const vars = Array.isArray(t.variables) ? t.variables : [];
        if (vars.length > 0) {
          lines.push("  variables:");
          for (const v of vars) {
            if (!v || typeof v.key !== "string") continue;
            const key = v.key;
            const desc = typeof v.description === "string" && v.description.trim() ? v.description.trim() : "(no description)";
            const sample = typeof v.sample === "string" && v.sample.trim() ? ` - sample: ${JSON.stringify(v.sample.trim())}` : "";
            lines.push(`    {{${key}}}: ${desc}${sample}`);
          }
        }
        const buttons = Array.isArray(t.buttons) ? t.buttons : [];
        if (buttons.length > 0) {
          const btnLabels = buttons
            .filter((b: any) => b && typeof b.text === "string" && b.text.trim())
            .map((b: any) => `${b.type || "QUICK_REPLY"}:"${b.text.trim()}"`)
            .join(", ");
          if (btnLabels) lines.push(`  buttons: ${btnLabels}`);
        }
      }
      out.templatesBlock = lines.join("\n");
    } else if (channel === "WHATSAPP" || channel === "") {
      out.templatesBlock = "## Approved WhatsApp templates\n- (none configured) - if the 24h window is closed, ask the team to register a callback template before scheduling.";
    }
  } catch (err: any) {
    console.warn("[ai-bot] loadFollowupFlowFacts templates:", err?.message);
  }

  return out;
}

/**
 * Why the AI stopped, in words the agent picking up the conversation can act on.
 *
 * The agent sees this in their inbox and has to decide what to tell a customer
 * who is waiting. "Remaining AI Units: 0" is true and useless when the real
 * problem is that the organization never completed payment.
 */
function billingPauseSummary(allowance: { reason?: string; balance: number }): string {
  switch (allowance.reason) {
    case "payment_required":
      return "AI paused - this organization's plan is not active yet. Payment has not been confirmed.";
    case "tenant_suspended":
      return "AI paused - this organization's account is suspended.";
    case "suspended":
      return "AI paused - the subscription is suspended.";
    case "canceled":
      return "AI paused - the subscription is canceled.";
    default:
      return `AI paused - AI Units exhausted. Remaining: ${allowance.balance}.`;
  }
}
