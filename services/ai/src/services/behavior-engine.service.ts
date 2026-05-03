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

export type LastAssistantMove =
  | "qualify"
  | "guide"
  | "convert"
  | "resolve"
  | "close";

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

  // Step 5 — Derived auxiliaries.
  const confidence = deriveConfidence({ conversationStage, intent });
  const autonomy = deriveAutonomy({ mode: input.mode, confidence, flags: input.flags });
  const escalationPressure = deriveEscalationPressure(input.flags, urgency);
  if (escalationPressure !== "none") overrides.push(`escalation_pressure=${escalationPressure}`);
  const toneIntensity = deriveTone({ strategy: strategyResult.strategy, urgency, conversationStage });
  const outputContract = deriveOutputContract(input);
  const allowedActions = deriveAllowedActions({
    strategy: strategyResult.strategy,
    autonomy,
    flags: input.flags,
    crmRecord: input.identity.crmRecord,
  });
  const requiredActions = deriveRequiredActions({
    strategy: strategyResult.strategy,
    intent,
    conversationStage,
    escalationPressure,
    lastAssistantMove: input.request.lastAssistantMove,
    lastMessage: input.request.lastMessage,
    crmRecord: input.identity.crmRecord,
  });
  const decisionIntent = deriveDecisionIntent({
    escalationPressure,
    autonomy,
    strategy: strategyResult.strategy,
    flags: input.flags,
  });
  const playbookIds = selectPlaybooks({
    strategy: strategyResult.strategy,
    conversationStage,
    intent,
    lastMessage: input.request.lastMessage,
  });

  return {
    schemaVersion: 2,
    mode: input.mode,
    userType,
    conversationStage,
    intent,
    urgency,
    engagementLevel: engagement,
    strategy: strategyResult.strategy,
    autonomy,
    toneIntensity,
    escalationPressure,
    confidence,
    outputContract,
    playbookIds,
    allowedActions,
    requiredActions,
    decisionIntent,
    provenance: {
      userType: userTypeSource,
      conversationStage: stageSource,
      intent: intentSource,
      urgency: urgencySource,
      engagementLevel: engagementSource,
      strategy: strategyResult.source,
      autonomy: `mode=${input.mode} confidence=${confidence} flags=${JSON.stringify(input.flags ?? {})}`,
      outputContract: outputContractProvenance(input),
      decisionIntent: decisionIntentProvenance({ escalationPressure, autonomy, strategy: strategyResult.strategy, flags: input.flags }),
      allowedActions: `derived from strategy=${strategyResult.strategy} autonomy=${autonomy} crm=${JSON.stringify(input.identity.crmRecord ?? {})} flags=${JSON.stringify(input.flags ?? {})}`,
      requiredActions: requiredActionsProvenance({ strategy: strategyResult.strategy, intent, escalationPressure, conversationStage }),
      playbookIds: `selected ${playbookIds.length} from catalog`,
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

function deriveRequiredActions(opts: {
  strategy: StrategyName;
  intent: Intent;
  conversationStage: ConversationStage;
  escalationPressure: EscalationPressure;
  lastAssistantMove?: LastAssistantMove;
  lastMessage: string;
  crmRecord?: { hasLead: boolean; hasContact: boolean };
}): ActionCategory[] {
  const out: ActionCategory[] = [];

  if (opts.escalationPressure === "escalate_now") {
    out.push("escalate_to_human");
    return out;
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
}): string {
  const parts: string[] = [];
  if (opts.escalationPressure === "escalate_now") parts.push("escalate_now → escalate_to_human");
  if (opts.strategy === "CONVERT" && opts.intent === "transactional") parts.push("CONVERT+transactional → create/update + schedule_booking");
  if (opts.strategy === "CONVERT" && opts.conversationStage === "objection") parts.push("CONVERT+objection → schedule_booking");
  if (opts.strategy === "RESOLVE") parts.push("RESOLVE → crm_read");
  if (opts.strategy === "QUALIFY" && opts.conversationStage !== "initial") parts.push("QUALIFY phase 2 → ask_question");
  return parts.join("; ") || "(no required actions)";
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
