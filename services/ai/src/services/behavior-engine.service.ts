/**
 * Behavior Engine Layer (BEL).
 *
 * Sits ABOVE the prompt builder. Decides WHAT the AI should do this turn —
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

/**
 * Contract enforcement state injected into BehaviorState (Action Contracts).
 * - active: at least one matching contract has unfulfilled tools.
 * - pendingTools: tool names the LLM MUST call this turn (or next valid turn).
 *                 For SEQUENCE contracts this is exactly one — the next step.
 *                 For ALL_REQUIRED / AT_LEAST_ONE it's the full unfulfilled set.
 * - completedTools: tool names already executed across THIS conversation
 *                   (carried over via ActionContractProgress).
 * - blocking: when true, allowedActions is restricted to pendingTools only.
 * - currentStep: for SEQUENCE — the next required tool name.
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
  /** 0..1 — direct answer 0.9, self-ref 0.85, implicit 0.7, ambiguous <0.5. */
  confidence: number;
}

export interface IdentifierMessage {
  kind: "email" | "phone";
  value: string;
}

/**
 * BehaviorState — the only object the prompt builder consumes from the BEL.
 * Frozen per-turn. Every field is required and from a closed enum.
 */
export interface BehaviorState {
  schemaVersion: 2;
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
   * Required output shape this turn. Decided by BEL — provider only renders.
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
   * this list — no other source of allowance.
   */
  allowedActions: ActionCategory[];
  /**
   * Action categories the model MUST exercise this turn (or explicitly
   * justify why not). Empty = no required action; reply alone is OK.
   */
  requiredActions: ActionCategory[];
  /**
   * What the BEL expects from this turn:
   *   PROGRESS — advance the strategy.
   *   HOLD     — wait (e.g. pending human approval); reply is allowed but no writes.
   *   ESCALATE — pivot to escalate_to_human; do not attempt resolution.
   */
  decisionIntent: DecisionIntent;
  /**
   * Identifier-ownership signal — drives whether `identity_link` is required
   * this turn. Computed from the customer's message + whether the assistant
   * had previously asked for an identifier.
   */
  ownershipSignal: OwnershipSignal;
  /**
   * Closure posture (Task 4):
   *   open            — conversation is mid-flight; do not close.
   *   ready_to_close  — goal achieved + customer acknowledged; close + summarize.
   *   needs_followup  — customer deferred; schedule a follow-up.
   */
  closurePosture: ClosurePosture;
  /**
   * Action Contract enforcement state. Empty/inert when no contracts match
   * this turn. When `active && blocking`, allowedActions is restricted to
   * `pendingTools` so the model physically cannot call anything else.
   */
  actionContractState: ActionContractStateView;
  /**
   * Provenance — which rule or input drove each axis.
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
  /** "lead" | "customer" — null when contact exists but lifecycle unknown. */
  contactLifecycle: "lead" | "customer" | null;
  priorConversationCount: number;
  /**
   * Pre-fetched CRM existence — caller computes from CRM prefetch.
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
   * BEL — not the provider — owns the output contract.
   */
  copilotPreferredMode?: "READY_MESSAGE" | "CONTEXT_ONLY" | "CHAT";
  /**
   * Tenant-configured funnel (Task 2). Optional. When provided, BEL applies:
   *   - Stage-label resolution (FunnelResolution.stageId added to provenance.overrides)
   *   - Strategy override (recomputes allowedActions/requiredActions with the
   *     overridden strategy)
   *   - Playbook override (replaces the platform-default playbook selection)
   * BEL stays the only decision layer — funnel is just a tenant-shaped
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
   * The tool the LLM is about to call this turn — passed in by the caller
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

  // Step 1 — Resolve user type.
  const { value: userType, source: userTypeSource } = resolveUserType(input.identity);

  // Step 2 — Determine conversation stage.
  const { value: conversationStage, source: stageSource } = resolveStage(input.request, input.flags);

  // Step 3 — Classify intent + urgency.
  const { intent, intentSource, urgency, urgencySource } = classifyIntentAndUrgency(input.request, input.flags);

  // Engagement.
  const { engagement, engagementSource } = deriveEngagement(input.identity, input.request);

  // Ownership signal — feeds requiredActions for identity_link.
  const ownershipSignal = deriveOwnership(input.request);
  // Closure posture — feeds requiredActions for close_conversation / schedule_followup.
  const closurePosture = deriveClosurePosture(input.request, input.flags);

  // Action Contracts — detect business triggers + enforce required tools.
  // Triggers are matched against tenant contracts; matching contracts
  // restrict allowedActions and add requiredActions.
  const triggeredActions = deriveTriggeredActions({
    lastMessage: input.request.lastMessage,
    intent,
    conversationStage,
    closurePosture,
  });

  // Step 4 — Strategy from the decision matrix + overrides.
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

  // Step 4a — Funnel overlay (Task 2). Resolves tenant stage label, may
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

  // Step 5 — Derived auxiliaries (use finalStrategy so overrides cascade).
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
  // Platform default playbook selection — funnel may replace it wholesale.
  const platformPlaybooks = selectPlaybooks({
    strategy: finalStrategy,
    conversationStage,
    intent,
    lastMessage: input.request.lastMessage,
  });
  const playbookIds: PlaybookId[] = funnelRes.playbookIds ?? platformPlaybooks;

  // Action Contract enforcement — runs LAST so it can clamp allowed/
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

  return {
    schemaVersion: 2,
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
      requiredActions: requiredActionsProvenance({ strategy: finalStrategy, intent, escalationPressure, conversationStage, closurePosture }),
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

// ─── Step 1 — Identity ──────────────────────────────────────

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

// ─── Step 2 — Stage ────────────────────────────────────────

function resolveStage(req: RequestInput, flags?: FlagsInput): { value: ConversationStage; source: string } {
  if (flags?.escalationGateFired || flags?.humanHandoffRequested) {
    return { value: "support", source: "escalation gate or handoff request" };
  }
  if (req.messageCount <= 1) return { value: "initial", source: "messageCount<=1" };

  const text = (req.lastMessage || "").toLowerCase();
  if (containsAny(text, SUPPORT_MARKERS)) return { value: "support", source: "support marker in message" };
  if (containsAny(text, OBJECTION_MARKERS)) return { value: "objection", source: "objection marker in message" };
  if (containsAny(text, DECISION_MARKERS)) return { value: "decision", source: "decision marker in message" };
  return { value: "exploration", source: "default — exploration" };
}

// ─── Step 3 — Intent + urgency ─────────────────────────────

function classifyIntentAndUrgency(
  req: RequestInput,
  flags?: FlagsInput,
): { intent: Intent; intentSource: string; urgency: Urgency; urgencySource: string } {
  const text = (req.lastMessage || "").toLowerCase();

  let intent: Intent = "unclear";
  let intentSource = "default — unclear";

  if (containsAny(text, SUPPORT_MARKERS)) {
    intent = "support";
    intentSource = "support keywords detected";
  } else if (containsAny(text, TRANSACTIONAL_MARKERS)) {
    intent = "transactional";
    intentSource = "transactional keywords detected";
  } else if (containsAny(text, INFORMATIONAL_MARKERS) || isQuestion(text)) {
    intent = "informational";
    intentSource = "informational keywords or question form";
  }

  let urgency: Urgency = "low";
  let urgencySource = "default — low";
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

// ─── Step 4 — Strategy decision matrix ─────────────────────

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

// ─── Step 5 — Derived auxiliaries ──────────────────────────

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
}): ActionCategory[] {
  let allowed = [...STRATEGY_CONTRACTS[opts.strategy].allowedActions];

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
  // Hebrew — verb-led only. (Bare "X של" overlaps with "שלי" = "my-X" so
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

  // Bare identifier with no third-party markers — implicit ownership.
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
    out.push("schedule_followup");
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
      // Customer accepted — MUST log the agreement to the CRM record.
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
}): string {
  const parts: string[] = [];
  if (opts.escalationPressure === "escalate_now") parts.push("escalate_now → escalate_to_human");
  if (opts.closurePosture === "ready_to_close") parts.push("ready_to_close → close_conversation");
  if (opts.closurePosture === "needs_followup") parts.push("needs_followup → schedule_followup");
  if (opts.strategy === "CONVERT" && opts.intent === "transactional") parts.push("CONVERT+transactional → create/update + schedule_booking");
  if (opts.strategy === "CONVERT" && opts.conversationStage === "objection") parts.push("CONVERT+objection → schedule_booking");
  if (opts.strategy === "RESOLVE") parts.push("RESOLVE → crm_read");
  if (opts.strategy === "QUALIFY" && opts.conversationStage !== "initial") parts.push("QUALIFY phase 2 → ask_question");
  return parts.join("; ") || "(no required actions)";
}

// ─── Action Contracts — trigger detection + state derivation ─

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
 *   - "refund"            — customer asking for money back
 *   - "booking"           — customer asking to schedule
 *   - "follow_up"         — customer deferred / asked to be re-contacted
 *   - "close_conversation"— ready to close (BEL closurePosture)
 *
 * Tenants can also write contracts on custom triggers — those will only
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
 * Compute the per-turn ActionContractStateView the BEL surfaces. Pure —
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
    if (prog?.fulfilledAt) continue; // already done — keep summary but no pending
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
  "אחשוב על זה", "תן לי לחשוב", "אחזור אליך", "אני אחזור", "אעדכן אותך",
  "בהמשך", "בעוד כמה ימים", "לא עכשיו", "פעם אחרת", "אדבר איתך",
];

const CUSTOMER_CLOSE_ACK_MARKERS = [
  "thanks", "thank you", "perfect", "great, thanks", "got it, thanks", "all good",
  "no thanks", "not interested", "no, thanks", "i'm good", "all set",
  "תודה", "תודה רבה", "מעולה תודה", "הכול טוב", "אני בסדר",
  "לא תודה", "לא מעוניין", "לא מעוניינת", "לא צריך",
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
 * - Escalation also blocks closure — handled by the earlier escalate_now branch
 *   in deriveRequiredActions (returns before closure check).
 */
function deriveClosurePosture(req: RequestInput, flags?: FlagsInput): ClosurePosture {
  if ((flags?.pendingApprovalsCount ?? 0) > 0) return "open";

  const text = (req.lastMessage || "").toLowerCase();

  // Customer explicitly defers → follow-up.
  if (containsAny(text, CUSTOMER_DEFER_MARKERS)) return "needs_followup";

  // Customer's terminal acknowledgement after a closing assistant move.
  const lastMove = req.lastAssistantMove;
  const isClosingMove = lastMove === "close" || lastMove === "resolve";
  if (isClosingMove && containsAny(text, CUSTOMER_CLOSE_ACK_MARKERS)) {
    return "ready_to_close";
  }

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
    schemaVersion: 2,
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
