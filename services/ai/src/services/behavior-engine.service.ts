/**
 * Behavior Engine Layer (BEL).
 *
 * Sits ABOVE the prompt builder. Decides WHAT the AI should do this turn -
 * the prompt builder decides HOW to say it.
 *
 * `computeBehaviorState()` is a pure function over its inputs:
 *   same inputs → same BehaviorState. No LLM call inside. No I/O.
 *
 * Callers (ai-bot.service, openai.provider) are responsible for fetching
 * identity / history / flags before calling. Keeping I/O at the call site
 * makes the engine deterministic and unit-testable.
 *
 * Decision flow (deterministic):
 *   1. Resolve user_type from identity inputs.
 *   2. Determine conversation_stage from message history + heuristics.
 *   3. Classify intent + urgency via rule-based heuristics (v1).
 *   4. Look up strategy in the decision matrix; apply override rules.
 *   5. Derive auxiliaries: confidence, autonomy, tone, escalation pressure,
 *      output contract, allowed actions, required actions, decision intent,
 *      and the playbook IDs that match this turn.
 */

import {
  type StrategyName,
  type ActionCategory,
  STRATEGY_CONTRACTS,
} from "./behavior-strategies";
import {
  CONVERSATION_PLAYBOOKS,
  PLAYBOOK_RENDER_ORDER,
  type PlaybookId,
} from "./conversation-playbooks";
import { resolveFunnel, type FunnelConfig } from "./funnel-config.service";
import {
  pendingToolsFor,
  isFulfilled,
  type ActionContract,
  type ActionContractProgress,
} from "./action-contracts.repo";

// ─── Types ──────────────────────────────────────────────────

export type AgentMode = "agent" | "copilot" | "generator";

export type UserType = "unknown" | "new_lead" | "returning" | "customer";

export type ConversationStage =
  | "initial"
  | "exploration"
  | "objection"
  | "decision"
  | "support";

export type Intent =
  | "informational"
  | "transactional"
  | "support"
  | "unclear";

export type Urgency = "low" | "medium" | "high";

export type EngagementLevel = "cold" | "warm" | "hot";

export type Autonomy = "full" | "gated" | "advisory";

export type ToneIntensity = "soft" | "neutral" | "assertive";

export type EscalationPressure = "none" | "watch" | "escalate_now";

export type Confidence = "high" | "medium" | "low";

export type OutputContract =
  | "REPLY"
  | "READY_MESSAGE"
  | "CONTEXT_ONLY"
  | "CHAT"
  | "STRUCTURED_CONFIG";

export type DecisionIntent = "PROGRESS" | "HOLD" | "ESCALATE";

export type ClosurePosture = "open" | "ready_to_close" | "needs_followup";

// ─── Behavioral signals (deterministic, explainable) ────────
//
// Three coarse reads of the customer the BEL computes every turn. They are
// NOT scores - each is a LOW/MEDIUM/HIGH bucket produced by an ordered,
// auditable rule ladder. Every signal carries the rule that fired (`reason`)
// and the concrete inputs that drove it (`evidence`), so audit logs can
// answer "why did the AI read the customer that way?".
//
// PHASE 1 (current): computed + surfaced in BehaviorState + the prompt's
// Conversation State block. They do NOT yet alter strategy/tone/escalation/
// closure - that wiring is a deliberate follow-up so the read-only signals
// can be observed in production first.

export type SignalLevel = "low" | "medium" | "high";
export type RelationshipStrength = SignalLevel;
export type TrustLevel = SignalLevel;
export type FrictionLevel = SignalLevel;

/**
 * A single behavioral read. `level` is the bucket; `reason` is a one-line
 * human-readable explanation of the rule that fired; `evidence` lists the
 * exact markers / structured inputs behind it. No hidden numeric scoring.
 */
export interface BehaviorSignal<L extends string = SignalLevel> {
  level: L;
  confidence: Confidence;
  reason: string;
  evidence: string[];
}

/**
 * Contract enforcement state injected into BehaviorState (Action Contracts).
 * - active: at least one matching contract has unfulfilled tools.
 * - pendingTools: tool names the LLM MUST call this turn (or next valid turn).
 *                 For SEQUENCE contracts this is exactly one - the next step.
 *                 For ALL_REQUIRED / AT_LEAST_ONE it's the full unfulfilled set.
 * - completedTools: tool names already executed across THIS conversation
 *                   (carried over via ActionContractProgress).
 * - blocking: when true, allowedActions is restricted to pendingTools only.
 * - currentStep: for SEQUENCE - the next required tool name.
 * - violatedThisTurn: set when the LLM tries to call a tool the contract
 *                     forbids (e.g. step 2 before step 1). Triggers retry.
 * - contracts: lightweight summary surfaced to the prompt builder.
 */
export interface ActionContractStateView {
  active: boolean;
  pendingTools: string[];
  completedTools: string[];
  blocking: boolean;
  currentStep?: string;
  violatedThisTurn?: { contractTrigger: string; reason: string };
  contracts: Array<{
    id: string;
    trigger: string;
    executionMode: "ALL_REQUIRED" | "SEQUENCE" | "AT_LEAST_ONE";
    requiredTools: string[];
    blocking: boolean;
    completed: string[];
    pending: string[];
    nextStep?: string;
  }>;
}

export type LastAssistantMove =
  | "qualify"
  | "guide"
  | "convert"
  | "resolve"
  | "close";

export type OwnershipEvidence =
  | "direct_response_to_assistant_question"
  | "self_referential_phrase"
  | "implicit_context"
  | "third_party"
  | "ambiguous"
  | "none";

export interface OwnershipSignal {
  /** True when we believe the identifier belongs to THIS customer. */
  ownerIsCustomer: boolean;
  evidence: OwnershipEvidence;
  /** 0..1 - direct answer 0.9, self-ref 0.85, implicit 0.7, ambiguous <0.5. */
  confidence: number;
}

export interface IdentifierMessage {
  kind: "email" | "phone";
  value: string;
}

/**
 * BehaviorState - the only object the prompt builder consumes from the BEL.
 * Frozen per-turn. Every field is required and from a closed enum.
 */
export interface BehaviorState {
  schemaVersion: 3;
  mode: AgentMode;
  userType: UserType;
  conversationStage: ConversationStage;
  intent: Intent;
  urgency: Urgency;
  engagementLevel: EngagementLevel;
  strategy: StrategyName;
  autonomy: Autonomy;
  toneIntensity: ToneIntensity;
  escalationPressure: EscalationPressure;
  confidence: Confidence;
  /**
   * Behavioral signals (PHASE 1 - observe-only). Deterministic LOW/MEDIUM/
   * HIGH reads of the customer, each with its own provenance. Surfaced in the
   * prompt's Conversation State block. NOT yet wired into strategy/tone/
   * escalation/closure - that is a deliberate follow-up.
   */
  relationshipStrength: BehaviorSignal<RelationshipStrength>;
  customerTrust: BehaviorSignal<TrustLevel>;
  customerFriction: BehaviorSignal<FrictionLevel>;
  /**
   * Required output shape this turn. Decided by BEL - provider only renders.
   */
  outputContract: OutputContract;
  /**
   * Conversation playbooks that match this turn (ordered for rendering).
   * Selected from the platform catalog; never authored freehand.
   */
  playbookIds: PlaybookId[];
  /**
   * Action categories permitted this turn. Strategy + autonomy + flags +
   * CRM existence already applied. The tool surface filter MUST consume
   * this list - no other source of allowance.
   */
  allowedActions: ActionCategory[];
  /**
   * Action categories the model MUST exercise this turn (or explicitly
   * justify why not). Empty = no required action; reply alone is OK.
   */
  requiredActions: ActionCategory[];
  /**
   * What the BEL expects from this turn:
   *   PROGRESS - advance the strategy.
   *   HOLD     - wait (e.g. pending human approval); reply is allowed but no writes.
   *   ESCALATE - pivot to escalate_to_human; do not attempt resolution.
   */
  decisionIntent: DecisionIntent;
  /**
   * Identifier-ownership signal - drives whether `identity_link` is required
   * this turn. Computed from the customer's message + whether the assistant
   * had previously asked for an identifier.
   */
  ownershipSignal: OwnershipSignal;
  /**
   * Closure posture (Task 4):
   *   open            - conversation is mid-flight; do not close.
   *   ready_to_close  - goal achieved + customer acknowledged; close + summarize.
   *   needs_followup  - customer deferred; schedule a follow-up.
   */
  closurePosture: ClosurePosture;
  /**
   * Action Contract enforcement state. Empty/inert when no contracts match
   * this turn. When `active && blocking`, allowedActions is restricted to
   * `pendingTools` so the model physically cannot call anything else.
   */
  actionContractState: ActionContractStateView;
  /**
   * Provenance - which rule or input drove each axis.
   * Required so audit logs can answer "why did the AI do that?".
   */
  provenance: {
    userType: string;
    conversationStage: string;
    intent: string;
    urgency: string;
    engagementLevel: string;
    strategy: string;
    autonomy: string;
    outputContract: string;
    decisionIntent: string;
    allowedActions: string;
    requiredActions: string;
    playbookIds: string;
    overrides: string[];
  };
}

// ─── Inputs ─────────────────────────────────────────────────

export interface IdentityInput {
  hasContact: boolean;
  /** "lead" | "customer" - null when contact exists but lifecycle unknown. */
  contactLifecycle: "lead" | "customer" | null;
  priorConversationCount: number;
  /**
   * Pre-fetched CRM existence - caller computes from CRM prefetch.
   * Lets BEL emit constrained allowedActions instead of leaving the
   * decision to runtime tool-stripping.
   */
  crmRecord?: {
    hasLead: boolean;
    hasContact: boolean;
  };
}

export interface RequestInput {
  /** Most recent inbound message text. Empty string is OK. */
  lastMessage: string;
  /** Total messages in this conversation, including the current inbound. */
  messageCount: number;
  /** Direction-only of the most recent N messages. */
  recentDirections?: Array<"INBOUND" | "OUTBOUND">;
  /**
   * Text of the most recent N INBOUND (customer) messages, oldest→newest,
   * INCLUDING the current message as the last element. Caller computes this
   * from the transcript (deterministic). Used by the trust / friction
   * classifiers to detect repeated verification requests, repeated
   * complaints, and the customer repeating themselves - patterns a single
   * message can't reveal. Optional: when omitted, those classifiers fall
   * back to `lastMessage` alone and lower their confidence.
   */
  recentInboundTexts?: string[];
  /**
   * Coarse last-assistant-move tag. Caller looks it up from the prior
   * `ai.bot_turn` audit log row.
   */
  lastAssistantMove?: LastAssistantMove;
  /**
   * Pre-extracted email/phone from the customer's last message, if present.
   * Caller is responsible for the regex extraction (deterministic).
   */
  identifierMessage?: IdentifierMessage;
  /**
   * If the assistant's previous turn asked the customer for an email or
   * phone, this captures which kind. Used to elevate ownership confidence
   * when the customer's reply contains a matching identifier.
   */
  assistantPreviouslyAskedFor?: "email" | "phone" | null;
  /**
   * Raw text of the assistant's previous outbound message in this
   * conversation. BEL uses this to detect cross-turn state that a
   * single-token enum can't carry - e.g. "the bot just asked the customer
   * for a follow-up time, so a timing-signal reply this turn means we
   * should now schedule the follow-up."
   */
  previousAssistantText?: string;
}

export interface FlagsInput {
  pendingApprovalsCount?: number;
  escalationGateFired?: boolean;
  humanHandoffRequested?: boolean;
}

export interface ComputeBehaviorStateInput {
  mode: AgentMode;
  identity: IdentityInput;
  request: RequestInput;
  flags?: FlagsInput;
  /**
   * Copilot-only: which output shape the agent prefers (READY_MESSAGE /
   * CONTEXT_ONLY / CHAT). Stored on the AIAgent record; passed in here so
   * BEL - not the provider - owns the output contract.
   */
  copilotPreferredMode?: "READY_MESSAGE" | "CONTEXT_ONLY" | "CHAT";
  /**
   * Tenant-configured funnel (Task 2). Optional. When provided, BEL applies:
   *   - Stage-label resolution (FunnelResolution.stageId added to provenance.overrides)
   *   - Strategy override (recomputes allowedActions/requiredActions with the
   *     overridden strategy)
   *   - Playbook override (replaces the platform-default playbook selection)
   * BEL stays the only decision layer - funnel is just a tenant-shaped
   * overlay on the same closed primitives (ConversationStage, Intent, etc.).
   */
  funnel?: FunnelConfig | null;
  /**
   * Tenant-defined Action Contracts. Caller pre-loads them via
   * loadActionContracts(tenantId). Empty/undefined → no contracts apply.
   */
  actionContracts?: ActionContract[];
  /**
   * Per-conversation contract progress. Caller pre-loads via
   * loadContractProgress({ conversationId }). Map keyed by contractId.
   */
  actionContractProgress?: Map<string, ActionContractProgress>;
  /**
   * The tool the LLM is about to call this turn - passed in by the caller
   * AFTER the model emits its tool_calls but BEFORE actual dispatch. Used
   * by SEQUENCE contracts to detect out-of-order calls. Optional: when
   * omitted (the prompt-build pass), no violation is flagged.
   */
  proposedToolCalls?: string[];
}

// ─── Public entry point ─────────────────────────────────────

export function computeBehaviorState(input: ComputeBehaviorStateInput): BehaviorState {
  if (input.mode === "generator") return buildGeneratorState(input);

  const overrides: string[] = [];

  // Step 1 - Resolve user type.
  const { value: userType, source: userTypeSource } = resolveUserType(input.identity);

  // Step 3 - Classify intent + urgency. Computed BEFORE stage so the stage
  // resolver can consult the accumulated intent (a lone "problem" word during a
  // sustained discovery shouldn't flip the whole turn to a support stage).
  const { intent, intentSource, urgency, urgencySource } = classifyIntentAndUrgency(input.request, input.flags);

  // Step 2 - Determine conversation stage (intent-aware).
  const { value: conversationStage, source: stageSource } = resolveStage(input.request, input.flags, intent);

  // Engagement.
  const { engagement, engagementSource } = deriveEngagement(input.identity, input.request);

  // Ownership signal - feeds requiredActions for identity_link.
  const ownershipSignal = deriveOwnership(input.request);
  // Closure posture - feeds requiredActions for close_conversation / schedule_followup.
  const closurePosture = deriveClosurePosture(input.request, input.flags);

  // Behavioral signals (PHASE 1 - observe-only). Deterministic LOW/MEDIUM/
  // HIGH reads computed from identity + request + the intent/urgency derived
  // above. They are surfaced in BehaviorState + the prompt but DO NOT alter
  // strategy, tone, escalation, or closure yet - that wiring is a follow-up.
  const relationshipStrength = deriveRelationshipStrength(input.identity);
  const customerTrust = deriveCustomerTrust({
    req: input.request,
    relationship: relationshipStrength.level,
  });
  const customerFriction = deriveCustomerFriction({
    req: input.request,
    flags: input.flags,
    intent,
    urgency,
  });

  // Action Contracts - detect business triggers + enforce required tools.
  // Triggers are matched against tenant contracts; matching contracts
  // restrict allowedActions and add requiredActions.
  const triggeredActions = deriveTriggeredActions({
    lastMessage: input.request.lastMessage,
    intent,
    conversationStage,
    closurePosture,
  });

  // Step 4 - Strategy from the decision matrix + overrides.
  const strategyResult = selectStrategy({
    mode: input.mode,
    userType,
    conversationStage,
    intent,
    urgency,
    engagement,
    flags: input.flags,
  });
  overrides.push(...strategyResult.overrides);

  // Step 4a - Funnel overlay (Task 2). Resolves tenant stage label, may
  // override strategy + playbookIds. Pure: no I/O. Caller hydrates the
  // funnel from DB before calling.
  const funnelRes = resolveFunnel({
    funnel: input.funnel ?? null,
    baseStage: conversationStage,
    intent,
    userType,
    strategy: strategyResult.strategy,
    lastMessage: input.request.lastMessage,
  });
  const finalStrategy: StrategyName = funnelRes.strategy;
  if (funnelRes.appliedReasons.length) overrides.push(...funnelRes.appliedReasons);

  // Step 5 - Derived auxiliaries (use finalStrategy so overrides cascade).
  const confidence = deriveConfidence({ conversationStage, intent });
  const autonomy = deriveAutonomy({ mode: input.mode, confidence, flags: input.flags });
  const escalationPressure = deriveEscalationPressure(input.flags, urgency);
  if (escalationPressure !== "none") overrides.push(`escalation_pressure=${escalationPressure}`);
  const toneIntensity = deriveTone({ strategy: finalStrategy, urgency, conversationStage });
  const outputContract = deriveOutputContract(input);
  const allowedActions = deriveAllowedActions({
    strategy: finalStrategy,
    autonomy,
    flags: input.flags,
    crmRecord: input.identity.crmRecord,
    closurePosture,
  });
  const requiredActions = deriveRequiredActions({
    strategy: finalStrategy,
    intent,
    conversationStage,
    escalationPressure,
    lastAssistantMove: input.request.lastAssistantMove,
    lastMessage: input.request.lastMessage,
    crmRecord: input.identity.crmRecord,
    ownershipSignal,
    closurePosture,
  });
  const decisionIntent = deriveDecisionIntent({
    escalationPressure,
    autonomy,
    strategy: finalStrategy,
    flags: input.flags,
  });
  // Platform default playbook selection - funnel may replace it wholesale.
  const platformPlaybooks = selectPlaybooks({
    strategy: finalStrategy,
    conversationStage,
    intent,
    lastMessage: input.request.lastMessage,
  });
  const playbookIds: PlaybookId[] = funnelRes.playbookIds ?? platformPlaybooks;

  // Action Contract enforcement - runs LAST so it can clamp allowed/
  // required actions on top of strategy + funnel decisions.
  const actionContractState = deriveActionContractState({
    triggeredActions,
    contracts: input.actionContracts || [],
    progressByContract: input.actionContractProgress || new Map(),
    proposedToolCalls: input.proposedToolCalls,
  });
  if (actionContractState.violatedThisTurn) {
    overrides.push(`contract_violation:${actionContractState.violatedThisTurn.contractTrigger}=${actionContractState.violatedThisTurn.reason}`);
  }
  if (actionContractState.active) {
    overrides.push(`action_contract.active triggers=[${triggeredActions.join(",")}] pending=[${actionContractState.pendingTools.join(",")}]`);
  }

  // Audit trail for the behavioral signals - full provenance lands in the
  // serialized BehaviorState (signal objects carry reason+evidence); these
  // one-liners make them grep-able in the overrides log too.
  overrides.push(`signal.relationshipStrength=${relationshipStrength.level} (${relationshipStrength.reason})`);
  overrides.push(`signal.customerTrust=${customerTrust.level} (${customerTrust.reason})`);
  overrides.push(`signal.customerFriction=${customerFriction.level} (${customerFriction.reason})`);

  return {
    schemaVersion: 3,
    mode: input.mode,
    userType,
    conversationStage,
    intent,
    urgency,
    engagementLevel: engagement,
    strategy: finalStrategy,
    autonomy,
    toneIntensity,
    escalationPressure,
    confidence,
    relationshipStrength,
    customerTrust,
    customerFriction,
    outputContract,
    playbookIds,
    allowedActions,
    requiredActions,
    decisionIntent,
    ownershipSignal,
    closurePosture,
    actionContractState,
    provenance: {
      userType: userTypeSource,
      conversationStage: stageSource,
      intent: intentSource,
      urgency: urgencySource,
      engagementLevel: engagementSource,
      strategy: finalStrategy === strategyResult.strategy
        ? strategyResult.source
        : `${strategyResult.source} → funnel-overridden to ${finalStrategy}`,
      autonomy: `mode=${input.mode} confidence=${confidence} flags=${JSON.stringify(input.flags ?? {})}`,
      outputContract: outputContractProvenance(input),
      decisionIntent: decisionIntentProvenance({ escalationPressure, autonomy, strategy: finalStrategy, flags: input.flags }),
      allowedActions: `derived from strategy=${finalStrategy} autonomy=${autonomy} crm=${JSON.stringify(input.identity.crmRecord ?? {})} flags=${JSON.stringify(input.flags ?? {})}`,
      requiredActions: requiredActionsProvenance({
        strategy: finalStrategy,
        intent,
        escalationPressure,
        conversationStage,
        closurePosture,
        hasTimingSignal: hasFollowupTimingSignal(input.request.lastMessage),
      }),
      playbookIds: funnelRes.playbookIds
        ? `funnel-overridden to [${playbookIds.join(",")}]`
        : `selected ${playbookIds.length} from catalog`,
      overrides,
    },
  };
}

// ─── KB retrieval gate (BEL-controlled) ─────────────────────

/**
 * The ONLY KB gate. Replaces the legacy `shouldSearchKB(text)` heuristic
 * that lived in the provider. Strategy contract decides whether to
 * retrieve at all; "when_relevant" falls back to a private regex check.
 */
export function shouldRetrieveKB(state: BehaviorState, lastMessage: string): boolean {
  const policy = STRATEGY_CONTRACTS[state.strategy].knowledgeRetrieval;
  if (policy === "skip") return false;
  if (policy === "always") return true;
  return isSemanticallyRetrievable(lastMessage);
}

/**
 * Private heuristic used inside `when_relevant`. Skips short, identifying,
 * or filler messages that have no semantic value for vector search.
 */
function isSemanticallyRetrievable(text: string): boolean {
  if (!text || text.trim().length < 8) return false;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
  if (/^\+?\d[\d\s().-]{5,}$/.test(trimmed)) return false;
  const skipPatterns = [
    /^(hi|hello|hey|shalom|שלום|היי|מה קורה|בוקר טוב|ערב טוב|לילה טוב)\b/,
    /^(thanks?|thank you|thx|ty|תודה|מעולה|סבבה|אחלה)\b/,
    /^(ok|okay|sure|yes|no|yep|nope|בסדר|כן|לא|אוקי|נכון)\b/,
    /^(bye|goodbye|see you|להתראות|ביי)\b/,
    /^(good morning|good evening|good night)\b/,
    /^👍|^❤️|^🙏|^😊|^👋/,
  ];
  for (const pattern of skipPatterns) if (pattern.test(lower)) return false;
  return true;
}

// ─── Step 1 - Identity ──────────────────────────────────────

function resolveUserType(id: IdentityInput): { value: UserType; source: string } {
  if (!id.hasContact) return { value: "unknown", source: "no contact found" };
  if (id.contactLifecycle === "customer") return { value: "customer", source: "contact lifecycle=customer" };
  if (id.contactLifecycle === "lead" && id.priorConversationCount > 0) {
    return { value: "returning", source: "lead with prior conversations" };
  }
  if (id.contactLifecycle === "lead") return { value: "new_lead", source: "lead with no prior conversations" };
  if (id.priorConversationCount > 0) return { value: "returning", source: "contact with prior conversations, lifecycle unknown" };
  return { value: "unknown", source: "contact with no lifecycle and no history" };
}

// ─── Step 2 - Stage ────────────────────────────────────────

function resolveStage(req: RequestInput, flags?: FlagsInput, intent?: Intent): { value: ConversationStage; source: string } {
  if (flags?.escalationGateFired || flags?.humanHandoffRequested) {
    return { value: "support", source: "escalation gate or handoff request" };
  }
  if (req.messageCount <= 1) return { value: "initial", source: "messageCount<=1" };

  const text = (req.lastMessage || "").toLowerCase();
  if (containsAny(text, SUPPORT_MARKERS)) {
    // Only treat the turn as a support stage when the customer's ACCUMULATED
    // intent agrees (or is still unclear). A passing "this doesn't work" during
    // a sustained discovery/buying thread is handled inside the active strategy
    // (and the urgency override still forces RESOLVE if it's genuinely urgent) -
    // it shouldn't yank the whole turn into problem-resolution mode.
    if (!intent || intent === "support" || intent === "unclear") {
      return { value: "support", source: "support marker + accumulated intent" };
    }
  }
  if (containsAny(text, OBJECTION_MARKERS)) return { value: "objection", source: "objection marker in message" };
  if (containsAny(text, DECISION_MARKERS)) return { value: "decision", source: "decision marker in message" };
  return { value: "exploration", source: "default - exploration" };
}

// ─── Step 3 - Intent + urgency ─────────────────────────────

function classifyIntentAndUrgency(
  req: RequestInput,
  flags?: FlagsInput,
): { intent: Intent; intentSource: string; urgency: Urgency; urgencySource: string } {
  // DYNAMIC intent: accumulate evidence across the recent inbound messages
  // (oldest→newest) instead of classifying the latest message in isolation.
  // This is what lets the strategy EVOLVE: a customer who opens "support" but
  // then asks five capability questions reads as informational/discovery, not
  // support - while a customer who stays on a problem keeps reading as support.
  //
  //  - Newer messages weigh more (recency ramp 1.0→2.0), so a genuine late
  //    topic shift can overtake the opening, but the opening still counts.
  //  - support / transactional markers are SPECIFIC (×1.5); the generic
  //    informational/question signal is weak (×1.0) so it doesn't drown out a
  //    real support or buying thread (almost every message is a question).
  const texts = (req.recentInboundTexts && req.recentInboundTexts.length > 0)
    ? req.recentInboundTexts
    : [req.lastMessage || ""];
  const n = texts.length;
  const scores: Record<"support" | "transactional" | "informational", number> = {
    support: 0, transactional: 0, informational: 0,
  };
  texts.forEach((raw, i) => {
    const t = (raw || "").toLowerCase();
    if (!t.trim()) return;
    const recency = n > 1 ? 1 + i / (n - 1) : 1; // oldest 1.0 → newest 2.0
    if (containsAny(t, SUPPORT_MARKERS)) scores.support += recency * 1.5;
    if (containsAny(t, TRANSACTIONAL_MARKERS)) scores.transactional += recency * 1.5;
    if (containsAny(t, INFORMATIONAL_MARKERS) || isQuestion(t)) scores.informational += recency * 1.0;
  });

  let intent: Intent = "unclear";
  let intentSource = "default - unclear (no markers across recent messages)";
  // Order matters for ties: specific intents win over generic informational.
  const ranked: Array<[Intent, number]> = ([
    ["support", scores.support],
    ["transactional", scores.transactional],
    ["informational", scores.informational],
  ] as Array<[Intent, number]>).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = ranked[0];
  if (topScore > 0) {
    intent = topIntent;
    const margin = topScore - ranked[1][1];
    intentSource = `accumulated ${topIntent} over ${n} msg (score=${topScore.toFixed(1)}, margin=${margin.toFixed(1)})`;
  }

  // Scheduling-change override: managing an EXISTING booking (move / reschedule /
  // push / cancel a meeting or demo) is a scheduling action the AI can fulfil
  // itself, NOT a support problem - even though "cancel" is a support marker.
  // Without this, "cancel my meeting" / "let's move the demo" scored as support →
  // strategy RESOLVE → the AI steered to resolve/escalate instead of calling
  // reschedule_meeting / cancel_meeting. Force transactional so the matrix routes
  // to CONVERT (which allows scheduling actions).
  const latest = (req.lastMessage || "").toLowerCase();
  const MEETING_REF = /(meeting|demo|appointment|\bcall\b|booking|פגיש|דמו|תור|שיחה)/i;
  const CHANGE_VERB = /(reschedul|postpone|push|\bmove\b|change|cancel|earlier|later|different time|another time|להזיז|לדחות|לשנות|לבטל|להקדים|מועד אחר|שעה אחרת|זמן אחר)/i;
  if (MEETING_REF.test(latest) && CHANGE_VERB.test(latest)) {
    intent = "transactional";
    intentSource = "scheduling change (manage existing booking) → transactional";
  }

  // Urgency stays anchored to the CURRENT message (+ flags): a fresh problem or
  // a "now!" should spike urgency this turn even mid-discovery.
  const text = (req.lastMessage || "").toLowerCase();
  let urgency: Urgency = "low";
  let urgencySource = "default - low";
  if (flags?.escalationGateFired || flags?.humanHandoffRequested) {
    urgency = "high";
    urgencySource = "escalation gate or handoff signal";
  } else if (containsAny(text, HIGH_URGENCY_MARKERS)) {
    urgency = "high";
    urgencySource = "high-urgency keywords";
  } else if (containsAny(text, MEDIUM_URGENCY_MARKERS)) {
    urgency = "medium";
    urgencySource = "medium-urgency keywords";
  }

  return { intent, intentSource, urgency, urgencySource };
}

function deriveEngagement(
  id: IdentityInput,
  req: RequestInput,
): { engagement: EngagementLevel; engagementSource: string } {
  if (req.messageCount >= 6) return { engagement: "hot", engagementSource: "active thread (>=6 messages)" };
  if (id.priorConversationCount > 0) return { engagement: "warm", engagementSource: "prior conversation history" };
  return { engagement: "cold", engagementSource: "no history" };
}

// ─── Step 4 - Strategy decision matrix ─────────────────────

interface StrategySelectorInput {
  mode: AgentMode;
  userType: UserType;
  conversationStage: ConversationStage;
  intent: Intent;
  urgency: Urgency;
  engagement: EngagementLevel;
  flags?: FlagsInput;
}

function selectStrategy(
  input: StrategySelectorInput,
): { strategy: StrategyName; source: string; overrides: string[] } {
  const overrides: string[] = [];

  if (input.mode === "copilot") {
    return { strategy: "SUPPORT_AGENT", source: "mode=copilot → SUPPORT_AGENT", overrides };
  }
  if (input.mode === "generator") {
    return { strategy: "N/A", source: "mode=generator", overrides };
  }

  // Override 1: high urgency + support intent → force RESOLVE.
  if (input.urgency === "high" && input.intent === "support") {
    overrides.push("urgency=high+support → force RESOLVE");
    return { strategy: "RESOLVE", source: "override: urgency=high & intent=support", overrides };
  }

  // Override 2: hard escalation flag → force RESOLVE.
  if (input.flags?.escalationGateFired || input.flags?.humanHandoffRequested) {
    overrides.push("escalation/handoff → force RESOLVE");
    return { strategy: "RESOLVE", source: "override: escalation gate or handoff", overrides };
  }

  // Override 3: hot engagement + transactional intent → force CONVERT (warm lead pace).
  if (input.engagement === "hot" && input.intent === "transactional") {
    overrides.push("engagement=hot + intent=transactional → force CONVERT");
    return { strategy: "CONVERT", source: "override: hot engagement & transactional intent", overrides };
  }

  // Main matrix.
  const matrixSource = `(${input.userType}, ${input.conversationStage}, ${input.intent})`;

  if ((input.userType === "unknown" || input.userType === "new_lead") && input.conversationStage === "initial") {
    return { strategy: "QUALIFY", source: `matrix ${matrixSource} → QUALIFY`, overrides };
  }
  if (input.intent === "support" || input.conversationStage === "support") {
    return { strategy: "RESOLVE", source: `matrix ${matrixSource} → RESOLVE`, overrides };
  }
  if (input.conversationStage === "decision" || input.intent === "transactional") {
    return { strategy: "CONVERT", source: `matrix ${matrixSource} → CONVERT`, overrides };
  }
  if (input.conversationStage === "objection" && (input.userType === "new_lead" || input.userType === "returning")) {
    return { strategy: "CONVERT", source: `matrix ${matrixSource} → CONVERT (objection handling)`, overrides };
  }
  if (input.conversationStage === "exploration" && input.intent === "informational") {
    return { strategy: "GUIDE", source: `matrix ${matrixSource} → GUIDE`, overrides };
  }
  if ((input.userType === "unknown" || input.userType === "new_lead") && input.intent === "unclear") {
    return { strategy: "QUALIFY", source: `matrix ${matrixSource} → QUALIFY (unclear intent)`, overrides };
  }
  return { strategy: "GUIDE", source: `matrix ${matrixSource} → GUIDE (default)`, overrides };
}

// ─── Step 5 - Derived auxiliaries ──────────────────────────

function deriveConfidence(opts: { conversationStage: ConversationStage; intent: Intent }): Confidence {
  if (opts.intent === "unclear") return "low";
  if (opts.conversationStage === "objection") return "medium";
  return "high";
}

function deriveAutonomy(opts: { mode: AgentMode; confidence: Confidence; flags?: FlagsInput }): Autonomy {
  if (opts.mode === "copilot") return "advisory";
  if (opts.mode === "generator") return "advisory";
  if (opts.flags?.escalationGateFired || opts.flags?.humanHandoffRequested) return "advisory";
  if (opts.confidence === "low") return "gated";
  if ((opts.flags?.pendingApprovalsCount ?? 0) > 0) return "gated";
  return "full";
}

function deriveEscalationPressure(flags: FlagsInput | undefined, urgency: Urgency): EscalationPressure {
  if (flags?.escalationGateFired || flags?.humanHandoffRequested) return "escalate_now";
  if (urgency === "high") return "watch";
  return "none";
}

function deriveTone(opts: {
  strategy: StrategyName;
  urgency: Urgency;
  conversationStage: ConversationStage;
}): ToneIntensity {
  if (opts.conversationStage === "objection") return "soft";
  if (opts.urgency === "high") return "neutral";
  return STRATEGY_CONTRACTS[opts.strategy].defaultToneIntensity;
}

function deriveOutputContract(input: ComputeBehaviorStateInput): OutputContract {
  if (input.mode === "agent") return "REPLY";
  if (input.mode === "generator") return "STRUCTURED_CONFIG";
  return input.copilotPreferredMode ?? "READY_MESSAGE";
}

function outputContractProvenance(input: ComputeBehaviorStateInput): string {
  if (input.mode === "agent") return "mode=agent → REPLY";
  if (input.mode === "generator") return "mode=generator → STRUCTURED_CONFIG";
  return `mode=copilot, copilotPreferredMode=${input.copilotPreferredMode ?? "(default READY_MESSAGE)"}`;
}

const HEAVY_WRITE_ACTIONS: ActionCategory[] = [
  "create_lead",
  "create_contact",
  "update_record",
  "schedule_followup",
  "schedule_booking",
  "send_proposal",
];

const ADVISORY_ALLOWED: ActionCategory[] = [
  "ask_question",
  "acknowledge",
  "explain",
  "summarize",
  "kb_lookup",
  "crm_read",
  "identity_link",
  "suggest_reply",
  "surface_insight",
  "propose_quick_action",
  "escalate_to_human",
];

function deriveAllowedActions(opts: {
  strategy: StrategyName;
  autonomy: Autonomy;
  flags?: FlagsInput;
  crmRecord?: { hasLead: boolean; hasContact: boolean };
  closurePosture?: ClosurePosture;
}): ActionCategory[] {
  let allowed = [...STRATEGY_CONTRACTS[opts.strategy].allowedActions];

  // Closure posture takes precedence over strategy gating - once the
  // conversation has reached its terminal state (ready_to_close /
  // needs_followup) the corresponding tool MUST be in the surface even if
  // the current strategy contract doesn't normally allow it. Mirrors the
  // requiredActions short-circuit in deriveRequiredActions. Without this,
  // QUALIFY/GUIDE strategies kept the bot from ever firing close_conversation
  // on a customer's "תודה" → chat stayed OPEN forever.
  if (opts.closurePosture === "ready_to_close" && !allowed.includes("close_conversation")) {
    allowed.push("close_conversation");
  }
  if (opts.closurePosture === "needs_followup" && !allowed.includes("schedule_followup")) {
    allowed.push("schedule_followup");
  }

  // CRM existence: if a lead/contact already exists, drop create_*.
  if (opts.crmRecord?.hasLead) allowed = allowed.filter((a) => a !== "create_lead");
  if (opts.crmRecord?.hasContact) allowed = allowed.filter((a) => a !== "create_contact");

  // Pending approvals → drop heavy writes.
  if ((opts.flags?.pendingApprovalsCount ?? 0) > 0) {
    allowed = allowed.filter((a) => !HEAVY_WRITE_ACTIONS.includes(a));
  }

  // Advisory autonomy (copilot, generator, escalation, low-confidence-cap).
  if (opts.autonomy === "advisory") {
    allowed = allowed.filter((a) => ADVISORY_ALLOWED.includes(a));
  }

  return allowed;
}

// ─── Ownership signal helpers (Task 1) ──────────────────────

const SELF_OWNERSHIP_MARKERS = [
  "my email", "my phone", "my number", "send to me", "reach me at",
  "האימייל שלי", "המייל שלי", "הטלפון שלי", "המספר שלי", "שלחו לי", "שלח לי",
];
const THIRD_PARTY_OWNERSHIP_MARKERS = [
  "support@", "info@", "contact@", "sales@",
  "send to my", "forward to", "tell my", "send it to ",
  // Hebrew - verb-led only. (Bare "X של" overlaps with "שלי" = "my-X" so
  // we cannot use "המייל של" / "האימייל של" as third-party markers.)
  "שלח ל", "שלחו ל", "תשלחו ל", "תשלח ל",
  // "X שלי" patterns where X is a person, not an identifier.
  "המנהל שלי", "העוזר שלי", "השותף שלי", "השותפה שלי", "האסיסטנט שלי",
];

function deriveOwnership(req: RequestInput): OwnershipSignal {
  if (!req.identifierMessage) {
    return { ownerIsCustomer: false, evidence: "none", confidence: 0 };
  }
  const text = (req.lastMessage || "").toLowerCase();

  // Third-party override has highest priority.
  if (containsAny(text, THIRD_PARTY_OWNERSHIP_MARKERS)) {
    return { ownerIsCustomer: false, evidence: "third_party", confidence: 0.95 };
  }

  // Direct answer to a prior assistant question of the matching kind.
  if (req.assistantPreviouslyAskedFor === req.identifierMessage.kind) {
    return { ownerIsCustomer: true, evidence: "direct_response_to_assistant_question", confidence: 0.9 };
  }

  // Self-referential phrase.
  if (containsAny(text, SELF_OWNERSHIP_MARKERS)) {
    return { ownerIsCustomer: true, evidence: "self_referential_phrase", confidence: 0.85 };
  }

  // Bare identifier with no third-party markers - implicit ownership.
  const trimmed = (req.lastMessage || "").trim().toLowerCase();
  if (trimmed === req.identifierMessage.value.toLowerCase()) {
    return { ownerIsCustomer: true, evidence: "implicit_context", confidence: 0.7 };
  }

  return { ownerIsCustomer: false, evidence: "ambiguous", confidence: 0.3 };
}

function deriveRequiredActions(opts: {
  strategy: StrategyName;
  intent: Intent;
  conversationStage: ConversationStage;
  escalationPressure: EscalationPressure;
  lastAssistantMove?: LastAssistantMove;
  lastMessage: string;
  crmRecord?: { hasLead: boolean; hasContact: boolean };
  ownershipSignal?: OwnershipSignal;
  closurePosture?: ClosurePosture;
}): ActionCategory[] {
  const out: ActionCategory[] = [];

  if (opts.escalationPressure === "escalate_now") {
    out.push("escalate_to_human");
    return out;
  }

  // Closure posture takes precedence over strategy-driven required actions:
  // once a conversation is over (or deferred), strategy moves are pointless.
  if (opts.closurePosture === "ready_to_close") {
    out.push("close_conversation");
    return out;
  }
  if (opts.closurePosture === "needs_followup") {
    // Only force schedule_followup when the customer actually gave us a time.
    // A vague "get back to me" / "תחזור אלי" with no when MUST trigger a
    // clarifying question first - otherwise the contract checker force-
    // retries the bot into scheduling at an arbitrary delay it invented.
    if (hasFollowupTimingSignal(opts.lastMessage)) {
      out.push("schedule_followup");
    } else {
      out.push("ask_question");
    }
    return out;
  }

  // Ownership-confirmed identifier → MUST link.
  if (opts.ownershipSignal && opts.ownershipSignal.ownerIsCustomer && opts.ownershipSignal.confidence >= 0.7) {
    out.push("identity_link");
  }

  if (opts.strategy === "CONVERT") {
    if (opts.intent === "transactional") {
      // Must capture the lead silently (or update if exists) AND propose a next step.
      if (!opts.crmRecord?.hasLead && !opts.crmRecord?.hasContact) out.push("create_lead");
      else out.push("update_record");
      out.push("schedule_booking");
    } else if (opts.conversationStage === "objection") {
      // Objection handling MUST end with a forward move.
      out.push("schedule_booking");
    } else if (opts.conversationStage === "decision") {
      // Customer accepted - MUST log the agreement to the CRM record.
      // (No schedule_booking here: it's already been agreed; logging is the close.)
      if (opts.crmRecord?.hasLead || opts.crmRecord?.hasContact) {
        out.push("update_record");
      } else {
        out.push("create_lead");
      }
    }
  }

  if (opts.strategy === "RESOLVE") {
    out.push("crm_read"); // diagnose before assuming
  }

  if (opts.strategy === "QUALIFY" && opts.conversationStage !== "initial") {
    // Phase 2 of QUALIFY must end with a question.
    out.push("ask_question");
  }

  return out;
}

function requiredActionsProvenance(opts: {
  strategy: StrategyName;
  intent: Intent;
  escalationPressure: EscalationPressure;
  conversationStage: ConversationStage;
  closurePosture?: ClosurePosture;
  hasTimingSignal?: boolean;
}): string {
  const parts: string[] = [];
  if (opts.escalationPressure === "escalate_now") parts.push("escalate_now → escalate_to_human");
  if (opts.closurePosture === "ready_to_close") parts.push("ready_to_close → close_conversation");
  if (opts.closurePosture === "needs_followup") {
    parts.push(
      opts.hasTimingSignal
        ? "needs_followup+timing → schedule_followup"
        : "needs_followup−timing → ask_question (must clarify when)",
    );
  }
  if (opts.strategy === "CONVERT" && opts.intent === "transactional") parts.push("CONVERT+transactional → create/update + schedule_booking");
  if (opts.strategy === "CONVERT" && opts.conversationStage === "objection") parts.push("CONVERT+objection → schedule_booking");
  if (opts.strategy === "RESOLVE") parts.push("RESOLVE → crm_read");
  if (opts.strategy === "QUALIFY" && opts.conversationStage !== "initial") parts.push("QUALIFY phase 2 → ask_question");
  return parts.join("; ") || "(no required actions)";
}

// ─── Action Contracts - trigger detection + state derivation ─

const REFUND_MARKERS = [
  "refund", "money back", "return my money", "chargeback", "give me back",
  "החזר", "החזר כספי", "תחזירו לי",
];
const BOOKING_MARKERS = [
  "book", "schedule", "set up a meeting", "set up a call", "demo",
  "discovery call", "consultation",
  "לקבוע", "להזמין פגישה", "תיאום פגישה", "הדגמה",
];
const FOLLOWUP_MARKERS = [
  "follow up", "get back to me", "call me later", "next week",
  "let me think", "i'll think about it", "i need to think",
  "תזכרו אותי", "תחזרו אליי", "בעוד כמה ימים",
  "תן לי לחשוב", "אחשוב על זה",
];

/**
 * Map the customer turn + BEL outputs to coarse business triggers. The
 * trigger names are tenant-meaningful labels matched verbatim against
 * `ActionContract.trigger`. Standard set:
 *   - "refund"            - customer asking for money back
 *   - "booking"           - customer asking to schedule
 *   - "follow_up"         - customer deferred / asked to be re-contacted
 *   - "close_conversation"- ready to close (BEL closurePosture)
 *
 * Tenants can also write contracts on custom triggers - those will only
 * fire if the caller passes them via `proposedToolCalls` / `triggeredActions`
 * derived elsewhere (e.g. from a flow node). The base set covers the
 * inline-message case deterministically.
 */
export function deriveTriggeredActions(opts: {
  lastMessage: string;
  intent?: Intent;
  conversationStage?: ConversationStage;
  closurePosture?: ClosurePosture;
}): string[] {
  const text = (opts.lastMessage || "").toLowerCase();
  const out = new Set<string>();

  if (containsAny(text, REFUND_MARKERS)) out.add("refund");
  if (containsAny(text, BOOKING_MARKERS) || opts.intent === "transactional") out.add("booking");
  if (opts.closurePosture === "needs_followup" || containsAny(text, FOLLOWUP_MARKERS)) {
    out.add("follow_up");
  }
  if (opts.closurePosture === "ready_to_close") out.add("close_conversation");

  return [...out];
}

/**
 * Compute the per-turn ActionContractStateView the BEL surfaces. Pure -
 * the caller pre-loads contracts + per-conversation progress.
 *
 * Logic per matching contract:
 *   1. Filter active contracts by triggeredActions.
 *   2. For each: derive completedTools (from progress) + pendingTools.
 *   3. Aggregate into a single state. blocking = any matching contract is blocking.
 *   4. If `proposedToolCalls` is set + a SEQUENCE contract is in flight,
 *      flag a violation when the LLM tries to call something other than
 *      the next-step tool. This drives the dispatcher's reject-and-retry.
 */
export function deriveActionContractState(opts: {
  triggeredActions: string[];
  contracts: ActionContract[];
  progressByContract: Map<string, ActionContractProgress>;
  proposedToolCalls?: string[];
}): ActionContractStateView {
  const matched = opts.contracts.filter(
    (c) => c.isActive && opts.triggeredActions.includes(c.trigger),
  );
  if (matched.length === 0) {
    return { active: false, pendingTools: [], completedTools: [], blocking: false, contracts: [] };
  }

  const allPending = new Set<string>();
  const allCompleted = new Set<string>();
  let blocking = false;
  let violation: ActionContractStateView["violatedThisTurn"];
  const summaries: ActionContractStateView["contracts"] = [];
  let firstSequenceNext: string | undefined;

  for (const c of matched) {
    const prog = opts.progressByContract.get(c.id);
    const completed = prog?.completedTools ?? [];
    if (prog?.fulfilledAt) continue; // already done - keep summary but no pending
    const pending = pendingToolsFor(c, completed);
    pending.forEach((p) => allPending.add(p));
    completed.forEach((c0) => allCompleted.add(c0));
    if (c.blocking) blocking = true;
    const orderArr = c.order && c.order.length ? c.order : c.requiredTools.map((t) => t.name);
    const nextStep = c.executionMode === "SEQUENCE" ? pending[0] : undefined;
    if (nextStep && !firstSequenceNext) firstSequenceNext = nextStep;

    summaries.push({
      id: c.id,
      trigger: c.trigger,
      executionMode: c.executionMode,
      requiredTools: c.requiredTools.map((t) => t.name),
      blocking: c.blocking,
      completed,
      pending,
      nextStep,
    });

    // Sequence violation detection.
    if (
      c.executionMode === "SEQUENCE" &&
      Array.isArray(opts.proposedToolCalls) &&
      opts.proposedToolCalls.length &&
      pending.length > 0
    ) {
      const expected = pending[0];
      const earlyContractTool = opts.proposedToolCalls.find(
        (t) => orderArr.includes(t) && t !== expected,
      );
      if (earlyContractTool) {
        violation = {
          contractTrigger: c.trigger,
          reason: `expected_${expected}_got_${earlyContractTool}`,
        };
      }
    }
  }

  return {
    active: allPending.size > 0,
    pendingTools: [...allPending],
    completedTools: [...allCompleted],
    blocking,
    currentStep: firstSequenceNext,
    violatedThisTurn: violation,
    contracts: summaries,
  };
}

// ─── Closure posture (Task 4) ───────────────────────────────

const CUSTOMER_DEFER_MARKERS = [
  "i'll think about it", "let me think", "get back to you", "i'll let you know",
  "later", "next week", "in a few days", "not right now", "not now", "another time",
  // Callback-intent phrases - "ai agrees verbally but never fires the
  // schedule tool" was rooted in these missing. Without a defer match the
  // BEL kept closurePosture=open, so requiredActions never pushed
  // schedule_followup and the bot had no reason to dispatch it.
  "call me back", "call back", "callback", "call me later", "call me tomorrow",
  "call me at", "ring me", "ring back", "talk to me later",
  "to call me back", "to call back", "to get back to me", "to ring me",
  "תחזרו אליי", "תחזור אליי", "תחזרו אלי", "תחזור אלי",
  "תתקשרו אלי", "תתקשר אלי", "תתקשר אליי", "תתקשרו אליי",
  // Infinitive forms - "תוכל לחזור אלי מחר?" / "אפשר להתקשר אליי" appear
  // very naturally in Hebrew callback requests and were missed by the
  // imperative-only markers above. Live test exposed this gap.
  "לחזור אלי", "לחזור אליי", "להתקשר אלי", "להתקשר אליי",
  "אחשוב על זה", "תן לי לחשוב", "אחזור אליך", "אני אחזור", "אעדכן אותך",
  "בהמשך", "בעוד כמה ימים", "לא עכשיו", "פעם אחרת", "אדבר איתך",
];

/**
 * Heuristic check: does the customer's message contain an explicit
 * follow-up timing signal STRONG ENOUGH to schedule on? This must
 * include an HOUR - a date alone ("tomorrow", "מחר") is NOT enough,
 * because the bot has no way to pick a sensible time of day and would
 * end up messaging the customer at an arbitrary hour.
 *
 * Returns true only when we can read BOTH:
 *   • a date/relative-day signal (today/tomorrow/specific day OR short
 *     duration like "in 2 hours"), AND
 *   • an actual hour ("at 7", "ב-7", "15:30", "3pm", "8 בערב" + digit).
 *
 * False negative is cheap (bot asks one extra clarifying question).
 * False positive is the bug we're fixing: bot picks its own time and
 * follows up when the customer didn't ask for that moment.
 */
function hasFollowupTimingSignal(rawText: string): boolean {
  const text = (rawText || "").toLowerCase();
  if (!text) return false;

  // ── Hour patterns (the load-bearing requirement) ──
  // 15:30 / 9.00 - clock format
  if (/\b\d{1,2}\s*[:.]\s*\d{2}\b/.test(text)) return true;
  // 3pm / 11 am
  if (/\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)\b/.test(text)) return true;
  // "at 3" / "at 10" - English "at <hour>"
  if (/\bat\s+\d{1,2}(\s|$|\.|,|!|\?)/.test(text)) return true;
  // Hebrew "ב-7" / "ב7" / "בשעה 7" - preposition + digit hour.
  // JS \b doesn't recognise Hebrew letters as word chars, so we anchor
  // with a negative lookbehind on Hebrew letters instead - this matches
  // the "ב" prefix when it stands alone, not as the last char of another
  // word.
  if (/(?<![א-ת])ב-?\s?\d{1,2}(?!\d)/.test(text)) return true;
  if (/בשעה\s*\d{1,2}/.test(text)) return true;
  // Compact Hebrew: "ב7 בבוקר" / "ב-15 אחה\"צ"
  if (/\d{1,2}\s*(בבוקר|בערב|בצהריים|בלילה|אחה"?צ|אחרי הצהריים)/.test(text)) return true;

  // ── Short durations (self-anchoring - "in 2 hours" is enough) ──
  if (/\bin\s+\d+\s*(hour|hours|min|mins|minutes)\b/.test(text)) return true;
  if (/\bבעוד\s*\d+\s*(שעה|שעות|דקות|דקה)\b/.test(text)) return true;
  if (/\bבעוד שעה\b|\bבעוד שעתיים\b/.test(text)) return true;
  if (/\bin an hour\b|\bin a couple of hours\b|\bin a few hours\b/.test(text)) return true;

  // Anything else (bare "מחר", "tomorrow", "next week", "ביום ראשון")
  // is a DATE without an hour. Not enough to schedule on. The bot must
  // ask a follow-up question per STEP 1 of the prompt.
  return false;
}

const CUSTOMER_CLOSE_ACK_MARKERS = [
  "thanks", "thank you", "perfect", "great, thanks", "got it, thanks", "all good",
  "no thanks", "not interested", "no, thanks", "i'm good", "all set",
  "תודה", "תודה רבה", "מעולה תודה", "הכול טוב", "אני בסדר",
  "לא תודה", "לא מעוניין", "לא מעוניינת", "לא צריך",
];

// Unambiguous customer-side sign-offs. Unlike CLOSE_ACK_MARKERS ("תודה"),
// these only appear when the customer is actually ending the conversation
// - so they don't need the prior-assistant-closing-move gate. A bare
// "תודה" stays open and relies on the existing isClosingMove + CLOSE_ACK
// path (or the idle worker's auto-close).
const CUSTOMER_FAREWELL_MARKERS = [
  "bye", "goodbye", "see you", "see ya", "take care", "have a good day",
  "have a great day", "talk soon", "ciao",
  "להתראות", "ביי", "להתראות בקרוב", "ביי ביי",
  "כל טוב", "שיהיה לך יום טוב", "שיהיה לכם יום טוב", "יום טוב",
];

/**
 * deriveClosurePosture (Task 4)
 *
 * Three states the BEL exposes to gate close_conversation / schedule_followup:
 *   - open:           default; mid-flight
 *   - ready_to_close: customer acknowledged after a closing assistant move
 *                     (booking confirmation / resolution), OR explicit decline.
 *                     This is the only posture where close_conversation fires.
 *   - needs_followup: customer explicitly deferred. Schedule outbound message.
 *
 * Notes:
 * - Pending approvals block closure (HOLD); BEL sets posture=open in that case.
 * - Escalation also blocks closure - handled by the earlier escalate_now branch
 *   in deriveRequiredActions (returns before closure check).
 */
// Markers that indicate the bot's previous turn was asking the customer
// for a follow-up time (HE+EN). Used cross-turn - when the customer replies
// to one of these with a timing signal, the conversation is still in the
// "schedule a follow-up" sub-flow even though their answer alone wouldn't
// match the defer markers.
const ASSISTANT_ASKED_FOLLOWUP_TIME_MARKERS = [
  // English
  "what time works", "when works for you", "when would be a good time",
  "when should i follow up", "when should i reach out", "when should i get back",
  "when would you like me to follow up", "what time should i",
  "follow up tomorrow", "follow up later", "good time to reach",
  "what time tomorrow", "what time would",
  // Hebrew
  "מתי נוח", "מתי יהיה לך נוח", "באיזו שעה", "באיזה שעה",
  "מתי כדאי", "מתי לחזור אליך", "מתי תרצה שאחזור",
  "מתי לחזור", "מתי לפנות אליך", "מתי בערך",
  "מחר בבוקר מתאים", "אחר הצהריים", "מתי שיהיה לך זמן",
  "מתי נוח לך שאחזור", "באיזה שעה תעדיף",
];

function deriveClosurePosture(req: RequestInput, flags?: FlagsInput): ClosurePosture {
  if ((flags?.pendingApprovalsCount ?? 0) > 0) return "open";

  const text = (req.lastMessage || "").toLowerCase();

  // Customer explicitly defers → follow-up.
  if (containsAny(text, CUSTOMER_DEFER_MARKERS)) return "needs_followup";

  // Cross-turn: bot just asked WHEN to follow up, and the customer's reply
  // contains a timing signal → still in the schedule-a-follow-up flow.
  // Without this, BEL would re-classify the conversation as "open" the
  // moment the customer answers the bot's clarifying question, which drops
  // schedule_followup from requiredActions and the tool never fires.
  const prevAssistant = (req.previousAssistantText || "").toLowerCase();
  const assistantAskedFollowupTime =
    !!prevAssistant && containsAny(prevAssistant, ASSISTANT_ASKED_FOLLOWUP_TIME_MARKERS);
  if (assistantAskedFollowupTime && hasFollowupTimingSignal(text)) {
    return "needs_followup";
  }
  // Bare-agreement to a follow-up-time proposal ("yes", "sure", "כן", "סבבה").
  // We're not done - still need to pin the exact hour - so STAY in
  // needs_followup posture so the prompt's STEP 1 "BARE AGREEMENT" branch
  // fires and the bot keeps pushing for a specific hour instead of letting
  // the conversation drift into a close.
  const BARE_AGREEMENT_MARKERS = [
    "yes", "sure", "ok", "okay", "sounds good", "works", "alright", "fine",
    "כן", "סבבה", "בסדר", "אוקי", "אוקיי", "מעולה", "אחלה", "טוב",
  ];
  if (assistantAskedFollowupTime && containsAny(text.trim(), BARE_AGREEMENT_MARKERS)) {
    return "needs_followup";
  }

  // Customer's terminal acknowledgement after a closing assistant move.
  const lastMove = req.lastAssistantMove;
  const isClosingMove = lastMove === "close" || lastMove === "resolve";
  if (isClosingMove && containsAny(text, CUSTOMER_CLOSE_ACK_MARKERS)) {
    return "ready_to_close";
  }

  // Explicit farewell - customer signed off with "bye"/"להתראות". This is
  // an UNAMBIGUOUS terminal signal so we don't need the prior-assistant-move
  // gate the CLOSE_ACK branch uses. A bare "תודה" is NOT enough (customers
  // drop it as politeness mid-conversation); only direct goodbyes fire here.
  if (containsAny(text, CUSTOMER_FAREWELL_MARKERS)) return "ready_to_close";

  // Hard decline → close (no point following up).
  const HARD_DECLINE = ["not interested", "לא מעוניין", "לא מעוניינת", "no thanks", "לא תודה"];
  if (containsAny(text, HARD_DECLINE)) return "ready_to_close";

  return "open";
}


function deriveDecisionIntent(opts: {
  escalationPressure: EscalationPressure;
  autonomy: Autonomy;
  strategy: StrategyName;
  flags?: FlagsInput;
}): DecisionIntent {
  if (opts.escalationPressure === "escalate_now") return "ESCALATE";
  if ((opts.flags?.pendingApprovalsCount ?? 0) > 0) return "HOLD";
  return "PROGRESS";
}

function decisionIntentProvenance(opts: {
  escalationPressure: EscalationPressure;
  autonomy: Autonomy;
  strategy: StrategyName;
  flags?: FlagsInput;
}): string {
  if (opts.escalationPressure === "escalate_now") return "escalate_now → ESCALATE";
  if ((opts.flags?.pendingApprovalsCount ?? 0) > 0) return "pendingApprovals>0 → HOLD";
  return `default for strategy=${opts.strategy} → PROGRESS`;
}

// ─── Playbook selection ────────────────────────────────────

function selectPlaybooks(opts: {
  strategy: StrategyName;
  conversationStage: ConversationStage;
  intent: Intent;
  lastMessage: string;
}): PlaybookId[] {
  const lower = (opts.lastMessage || "").toLowerCase();
  const out: PlaybookId[] = [];

  for (const id of PLAYBOOK_RENDER_ORDER) {
    const pb = CONVERSATION_PLAYBOOKS[id];
    const t = pb.trigger;
    if (t.strategies && !t.strategies.includes(opts.strategy)) continue;
    if (t.stages && !t.stages.includes(opts.conversationStage)) continue;
    if (t.intents && !t.intents.includes(opts.intent)) continue;
    if (t.markers && !t.markers.some((m) => lower.includes(m.toLowerCase()))) continue;
    out.push(id);
  }
  return out;
}

// ─── Generator-mode shortcut ───────────────────────────────

function buildGeneratorState(input: ComputeBehaviorStateInput): BehaviorState {
  return {
    schemaVersion: 3,
    mode: "generator",
    userType: input.identity.hasContact ? "returning" : "unknown",
    conversationStage: "initial",
    intent: "unclear",
    urgency: "low",
    engagementLevel: "warm",
    strategy: "N/A",
    autonomy: "advisory",
    toneIntensity: "neutral",
    escalationPressure: "none",
    confidence: "high",
    relationshipStrength: deriveRelationshipStrength(input.identity),
    customerTrust: {
      level: "medium",
      confidence: "high",
      reason: "generator-mode - no live customer to read",
      evidence: ["mode=generator"],
    },
    customerFriction: {
      level: "low",
      confidence: "high",
      reason: "generator-mode - no live customer to read",
      evidence: ["mode=generator"],
    },
    outputContract: "STRUCTURED_CONFIG",
    playbookIds: [],
    allowedActions: [],
    requiredActions: [],
    decisionIntent: "PROGRESS",
    ownershipSignal: { ownerIsCustomer: false, evidence: "none", confidence: 0 },
    closurePosture: "open",
    actionContractState: {
      active: false,
      pendingTools: [],
      completedTools: [],
      blocking: false,
      contracts: [],
    },
    provenance: {
      userType: "generator-mode shortcut",
      conversationStage: "generator-mode shortcut",
      intent: "n/a",
      urgency: "n/a",
      engagementLevel: "generator-mode shortcut",
      strategy: "mode=generator → N/A",
      autonomy: "generator → advisory",
      outputContract: "mode=generator → STRUCTURED_CONFIG",
      decisionIntent: "generator → PROGRESS",
      allowedActions: "(generator: empty allowed actions)",
      requiredActions: "(generator: no required actions)",
      playbookIds: "(generator: no playbooks)",
      overrides: [],
    },
  };
}

// ─── Behavioral signal classifiers (deterministic, explainable) ─────
//
// Each is an ordered rule ladder: first match wins and records the rule
// (`reason`) + the inputs behind it (`evidence`). No numeric scoring.

const LOYAL_CUSTOMER_THRESHOLD = 3;

/**
 * relationshipStrength - depth of the ongoing relationship, from CRM facts
 * ONLY (no language parsing). Always HIGH confidence because it is derived
 * from structured identity data, not noisy text.
 *
 *   LOW    - first-time contact / brand-new lead (no history).
 *   MEDIUM - returning lead, or an existing customer with little history.
 *   HIGH   - long-term customer (>= LOYAL_CUSTOMER_THRESHOLD prior convos).
 */
function deriveRelationshipStrength(id: IdentityInput): BehaviorSignal<RelationshipStrength> {
  const prior = id.priorConversationCount ?? 0;

  if (!id.hasContact) {
    return {
      level: "low",
      confidence: "high",
      reason: "no CRM contact → first-time customer",
      evidence: ["hasContact=false"],
    };
  }

  if (id.contactLifecycle === "customer") {
    if (prior >= LOYAL_CUSTOMER_THRESHOLD) {
      return {
        level: "high",
        confidence: "high",
        reason: `long-term customer (${prior} prior conversations ≥ ${LOYAL_CUSTOMER_THRESHOLD})`,
        evidence: ["lifecycle=customer", `priorConversationCount=${prior}`],
      };
    }
    return {
      level: "medium",
      confidence: "high",
      reason: `existing customer (${prior} prior conversation${prior === 1 ? "" : "s"})`,
      evidence: ["lifecycle=customer", `priorConversationCount=${prior}`],
    };
  }

  if (id.contactLifecycle === "lead") {
    if (prior >= 1) {
      return {
        level: "medium",
        confidence: "high",
        reason: `returning lead (${prior} prior conversation${prior === 1 ? "" : "s"})`,
        evidence: ["lifecycle=lead", `priorConversationCount=${prior}`],
      };
    }
    return {
      level: "low",
      confidence: "high",
      reason: "new lead (no prior conversations)",
      evidence: ["lifecycle=lead", "priorConversationCount=0"],
    };
  }

  // Contact exists but lifecycle is unknown - lean on history only.
  if (prior >= 1) {
    return {
      level: "medium",
      confidence: "medium",
      reason: `returning contact, lifecycle unknown (${prior} prior conversations)`,
      evidence: ["lifecycle=null", `priorConversationCount=${prior}`],
    };
  }
  return {
    level: "low",
    confidence: "medium",
    reason: "contact with no history, lifecycle unknown",
    evidence: ["lifecycle=null", "priorConversationCount=0"],
  };
}

/**
 * customerTrust - how much the customer appears to believe the agent/brand
 * right now. Baseline is anchored by the relationship (previous successful
 * interactions ⇒ trust), then adjusted by language in the current + recent
 * inbound messages.
 *
 *   LOW    - repeated verification requests, or skeptical language.
 *   HIGH   - positive engagement, or a long-term relationship with no
 *            distrust signal.
 *   MEDIUM - neutral / insufficient signal (default).
 */
function deriveCustomerTrust(opts: {
  req: RequestInput;
  relationship: RelationshipStrength;
}): BehaviorSignal<TrustLevel> {
  const text = (opts.req.lastMessage || "").toLowerCase();
  const pool = inboundPool(opts.req);

  // 1. Repeated verification requests across recent inbound → LOW.
  const verifyCount = countMessagesWithMarkers(pool, VERIFICATION_MARKERS);
  if (verifyCount >= 2) {
    return {
      level: "low",
      confidence: "medium",
      reason: "repeated verification requests across messages",
      evidence: [`verificationMessages=${verifyCount}`],
    };
  }

  // 2. Skeptical language in the latest message → LOW.
  const skeptHit = firstMarkerHit(text, SKEPTICAL_MARKERS);
  if (skeptHit) {
    return {
      level: "low",
      confidence: "medium",
      reason: `skeptical language: "${skeptHit}"`,
      evidence: [skeptHit],
    };
  }

  // 3. Positive engagement → HIGH (firmer when the relationship backs it up).
  const posHit = firstMarkerHit(text, POSITIVE_ENGAGEMENT_MARKERS);
  if (posHit) {
    return {
      level: "high",
      confidence: opts.relationship === "high" ? "high" : "medium",
      reason: `positive engagement: "${posHit}"`,
      evidence: [posHit, `relationshipStrength=${opts.relationship}`],
    };
  }

  // 4. Long-term relationship with no distrust signal → HIGH baseline.
  if (opts.relationship === "high") {
    return {
      level: "high",
      confidence: "medium",
      reason: "long-term relationship, no distrust signal this turn",
      evidence: ["relationshipStrength=high"],
    };
  }

  // 5. Neutral. Confidence drops when there's barely any text to judge.
  return {
    level: "medium",
    confidence: text.trim().length < 8 ? "low" : "medium",
    reason: "neutral / insufficient trust signal",
    evidence: [],
  };
}

/**
 * customerFriction - how much resistance/frustration the customer is
 * experiencing right now.
 *
 *   HIGH   - escalation/handoff flag, repeated complaints, or the customer
 *            repeating themselves.
 *   MEDIUM - single negative-sentiment message, or urgent support pressure.
 *   LOW    - default.
 */
function deriveCustomerFriction(opts: {
  req: RequestInput;
  flags?: FlagsInput;
  intent: Intent;
  urgency: Urgency;
}): BehaviorSignal<FrictionLevel> {
  const text = (opts.req.lastMessage || "").toLowerCase();
  const pool = inboundPool(opts.req);

  // 1. Hard flags - deterministic, HIGH confidence.
  if (opts.flags?.escalationGateFired || opts.flags?.humanHandoffRequested) {
    return {
      level: "high",
      confidence: "high",
      reason: "escalation/handoff flag fired",
      evidence: [
        opts.flags?.escalationGateFired ? "escalationGateFired" : "",
        opts.flags?.humanHandoffRequested ? "humanHandoffRequested" : "",
      ].filter(Boolean),
    };
  }

  // 2. Repeated complaints / negative sentiment across recent inbound → HIGH.
  const negCount = countMessagesWithMarkers(pool, FRICTION_NEGATIVE_MARKERS);
  if (negCount >= 2) {
    return {
      level: "high",
      confidence: "medium",
      reason: "repeated complaints / negative sentiment across messages",
      evidence: [`negativeMessages=${negCount}`],
    };
  }

  // 3. Customer repeating themselves → HIGH.
  const rep = detectRepetition(opts.req.recentInboundTexts);
  if (rep) {
    return {
      level: "high",
      confidence: "medium",
      reason: "customer repeating themselves",
      evidence: [rep],
    };
  }

  // 4. Single negative-sentiment message → MEDIUM.
  const negHit = firstMarkerHit(text, FRICTION_NEGATIVE_MARKERS);
  if (negHit) {
    return {
      level: "medium",
      confidence: "medium",
      reason: `negative sentiment: "${negHit}"`,
      evidence: [negHit],
    };
  }

  // 5. Urgent support pressure → MEDIUM.
  if (opts.urgency === "high" && opts.intent === "support") {
    return {
      level: "medium",
      confidence: "medium",
      reason: "urgent support pressure",
      evidence: ["urgency=high", "intent=support"],
    };
  }

  return {
    level: "low",
    confidence: "medium",
    reason: "no friction signal",
    evidence: [],
  };
}

// ─── Signal helpers ─────────────────────────────────────────

/**
 * The inbound messages to scan for multi-message patterns. Prefers the
 * caller-supplied `recentInboundTexts` (lowercased); falls back to just the
 * last message when the caller didn't provide history.
 */
function inboundPool(req: RequestInput): string[] {
  const recent = (req.recentInboundTexts ?? []).map((t) => (t || "").toLowerCase());
  if (recent.length) return recent;
  const last = (req.lastMessage || "").toLowerCase();
  return last ? [last] : [];
}

function countMessagesWithMarkers(messages: string[], markers: string[]): number {
  let n = 0;
  for (const m of messages) if (containsAny(m, markers)) n++;
  return n;
}

function firstMarkerHit(text: string, markers: string[]): string | null {
  for (const mk of markers) if (text.includes(mk)) return mk;
  return null;
}

/** Lowercase + collapse all punctuation/symbols/whitespace to single spaces. */
function normalizeForRepetition(s: string): string {
  return (s || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}

/**
 * Deterministic "is the customer repeating themselves?" check over the two
 * most-recent inbound messages. Explainable, not fuzzy: an exact normalized
 * match, or a token-set overlap (Jaccard) at/above a STATED threshold.
 * Returns an evidence string when it fires, else null.
 */
function detectRepetition(recentInboundTexts?: string[]): string | null {
  const recent = recentInboundTexts ?? [];
  if (recent.length < 2) return null;
  const a = normalizeForRepetition(recent[recent.length - 1]);
  const b = normalizeForRepetition(recent[recent.length - 2]);
  if (!a || !b) return null;
  if (a === b) return "two consecutive inbound messages are identical";
  const overlap = jaccard(a.split(" "), b.split(" "));
  if (overlap >= 0.8) return `consecutive inbound token-overlap=${overlap.toFixed(2)} ≥ 0.80`;
  return null;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

// ─── Signal marker sets (HE + EN) ───────────────────────────

const SKEPTICAL_MARKERS = [
  "really?", "are you sure", "you sure", "prove it", "i don't believe", "i dont believe",
  "sounds too good", "too good to be true", "is this a scam", "scam", "are you a bot",
  "is this a bot", "are you real", "how can i trust", "i doubt", "suspicious",
  "באמת?", "אתה בטוח", "את בטוחה", "אתם בטוחים", "תוכיח", "תוכיחו", "לא מאמין",
  "לא מאמינה", "נשמע טוב מדי", "רמאות", "אתה בוט", "זה בוט", "חשוד",
];

const VERIFICATION_MARKERS = [
  "can you confirm", "please confirm", "how do i know", "is this official",
  "send proof", "show proof", "any proof", "do you have proof", "verify",
  "verification", "guarantee", "is it legit", "is this legit",
  "תאשר", "תאשרו", "אפשר לאמת", "איך אני יודע", "איך אני יודעת", "זה רשמי",
  "תשלח הוכחה", "יש הוכחה", "אפשר לוודא", "תוכלו לאשר", "אחריות",
];

const POSITIVE_ENGAGEMENT_MARKERS = [
  "thank you", "thanks", "thx", "appreciate", "great", "perfect", "awesome",
  "amazing", "love it", "excellent", "wonderful", "you're the best", "helpful",
  "👍", "❤️", "🙏", "😊", "🎉",
  "תודה", "מעולה", "מושלם", "מדהים", "אלוף", "אלופה", "עזרת", "עזרתם", "אחלה", "סבבה",
];

const FRICTION_NEGATIVE_MARKERS = [
  // English - frustration / complaint
  "unacceptable", "ridiculous", "still not", "still doesn't", "still doesnt",
  "not working", "doesn't work", "doesnt work", "third time", "second time",
  "frustrated", "frustrating", "fed up", "angry", "terrible", "awful", "worst",
  "useless", "waste of time", "nobody helped", "no one helped", "this is a joke",
  // Hebrew - frustration / complaint
  "לא עובד", "לא עבד", "מתוסכל", "מתוסכלת", "כועס", "כועסת", "עצבני",
  "שוב פעם", "פעם שלישית", "פעם שנייה", "נמאס", "מספיק", "לא ייאמן",
  "גרוע", "נורא", "בזבוז זמן", "אף אחד לא", "מקולקל", "זאת בדיחה",
];

// ─── Heuristic markers (v1 rules; replaceable with classifier later) ──

const SUPPORT_MARKERS = [
  "broken", "doesn't work", "not working", "can't", "cannot", "issue", "problem",
  "bug", "error", "stuck", "help me", "complaint", "refund", "cancel", "wrong",
  "מקולקל", "לא עובד", "בעיה", "תקלה", "תקועה", "תקוע", "החזר", "ביטול", "לא בסדר",
];

const OBJECTION_MARKERS = [
  "but", "however", "too expensive", "i don't think", "not sure", "maybe later",
  "concern", "worried", "skeptical", "not a fit", "can't afford",
  "אבל", "יקר מדי", "לא בטוח", "אולי בהמשך", "מודאג", "לא מתאים",
];

const DECISION_MARKERS = [
  "let's do it", "i'm in", "sign me up", "i want to", "i'd like to buy",
  "let's book", "let's schedule", "yes please", "ok let's go",
  "send me a quote", "send me the proposal", "ready to start",
  "אני בפנים", "בוא נקבע", "אני רוצה", "כן בוא נעשה", "אני רוצה לקנות",
  "תשלחו לי הצעה", "מוכן להתחיל",
];

const TRANSACTIONAL_MARKERS = [
  "buy", "purchase", "order", "book", "schedule", "pay", "subscribe", "sign up",
  "לקנות", "להזמין", "לקבוע", "לשלם", "להירשם",
  "how much", "what's the cost", "what does it cost", "what's the price",
  "pricing", "price list", "price plan", "do you have a demo", "can i see a demo",
  "free trial", "trial period", "discount",
  "כמה עולה", "כמה זה עולה", "מה המחיר", "מה העלות", "מחירון",
  "תוכנית מחיר", "מסלול", "דמו", "ניסיון", "הדגמה", "תקופת ניסיון", "הנחה",
  // Booking / meeting requests - customer is signaling they want a real next step.
  "demo", "meeting", "appointment", "consultation", "call back", "callback",
  "set up a call", "set up a meeting", "set up a demo", "schedule a call",
  "schedule a meeting", "schedule a demo", "book a call", "book a meeting",
  "book a demo", "jump on a call", "hop on a call", "quick call",
  "talk to sales", "speak with sales", "speak to sales", "sales rep",
  "פגישה", "תור", "התייעצות", "שיחה קצרה", "לקבוע פגישה", "לקבוע שיחה",
  "לקבוע דמו", "לדבר עם איש מכירות", "לדבר עם נציג מכירות",
  // Buying-stage signals that aren't questions about price.
  "interested in", "i'm interested", "im interested", "tell me more about pricing",
  "next step", "next steps", "get started", "how do i get started",
  "how do we get started", "how do i start", "how to start", "how to begin",
  "ready to move forward", "let's move forward", "move forward",
  "מעוניין", "מעניין אותי", "השלב הבא", "צעד הבא", "להתחיל", "איך מתחילים",
  "איך אני מתחיל", "מוכן להתקדם",
];

const INFORMATIONAL_MARKERS = [
  "how", "what", "why", "when", "where", "tell me", "explain", "info", "details",
  "איך", "מה", "למה", "מתי", "איפה", "ספר לי", "תסביר",
];

const HIGH_URGENCY_MARKERS = [
  "urgent", "asap", "immediately", "right now", "emergency", "critical",
  "דחוף", "עכשיו", "מייד", "חירום", "קריטי",
];

const MEDIUM_URGENCY_MARKERS = [
  "soon", "today", "this week", "by tomorrow",
  "בקרוב", "היום", "השבוע", "עד מחר",
];

function containsAny(text: string, markers: string[]): boolean {
  for (const m of markers) if (text.includes(m)) return true;
  return false;
}

function isQuestion(text: string): boolean {
  if (!text) return false;
  return /[?؟]/.test(text);
}
