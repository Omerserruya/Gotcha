/**
 * Action Planning Layer.
 *
 * The runtime already KNOWS the goal, the objective, what's missing, readiness
 * (wizard facts), the committed goal, and the candidate next actions. Today that
 * knowledge is scattered across ~6 prompt sections and the model has to
 * re-assemble it. The planner aggregates it ONCE, before the model reasons, into
 * a single compact `CurrentPlan` — "here is the goal, the situation, and the best
 * next action" — exactly how a real employee thinks.
 *
 * It does NOT replace model reasoning: it gives the model the best CURRENT plan;
 * the model may still deviate if the customer's latest message changes things.
 *
 * Completely generic / role-agnostic. It reuses the existing runtime functions
 * (computeProspectState, selectActiveObjective, commitObjective,
 * resolveNextActions, groupToolsIntoCapabilities) — zero recomputation of new
 * state, no new LLM call, pure and never throws.
 */

import { computeProspectState, type CrmStateFlags, type ProspectState } from "./prospect-state";
import {
  selectActiveObjective,
  commitObjective,
  resolveNextActions,
  renderQualifyOutDirective,
  resolveGoalObjective,
  EMPTY_WIZARD_FACTS,
  type ObjectiveName,
  type ObjectiveStatus,
  type ActiveGoalSnapshot,
  type NextActionCandidate,
  type NextActionKind,
  type WizardRuntimeFacts,
} from "./objectives";
import {
  groupToolsIntoCapabilities,
  capabilityOfTool,
  renderCapabilities,
  type CapabilityGroup,
} from "./capabilities";
import {
  evaluateGoalStatus,
  presentBusinessOutcomes,
  type GoalStatus,
  type RecoverySignal,
} from "./goal-evaluator";

/**
 * Everything the planner needs, as a narrow structural input. The prompt builder
 * passes a superset (BuildPromptOpts) which satisfies this — keeping the planner
 * decoupled from the builder (no circular import).
 */
export interface PlanInput {
  /** Agent role → objective chain. */
  role: string;
  /** CRM presence flags for this customer → prospect state + chain selection. */
  prospectFlags: CrmStateFlags;
  /** Concatenated resolved-fact text (customer + CRM + memory + session). */
  factText: string;
  /** Action tools that already SUCCEEDED earlier this conversation. */
  completedActionTools: string[];
  /** Whether a meeting can actually be booked this conversation. */
  calendarBookable?: boolean;
  /** Committed goal carried from the previous turn (Goal Ownership). */
  priorGoal?: ActiveGoalSnapshot | null;
  /** Structured wizard→runtime facts (goal/qualification/fit). */
  wizardFacts?: WizardRuntimeFacts;
  /** OpenAI tool function names dispatchable this turn (the capability surface). */
  toolFunctionNames: string[];
  /** Optional toolName → Integration.category map (for capability grouping). */
  toolCapabilityHints?: Record<string, string>;
  /** Behavior strategy display name (GUIDE/QUALIFY/CONVERT…), for the situation line. */
  strategyName?: string;
  /**
   * Whether the customer has an ACTIVE booking right now (the MeetingBooking
   * store's current state). One of the runtime homes the Goal Evaluator reads to
   * decide whether a `booking` outcome exists — no audit reconstruction.
   */
  hasActiveBooking?: boolean;
  /** Recovery (Unit C) signal for the goal's action, when known (post-action). */
  recovery?: RecoverySignal;
  /** An approval is pending on the goal's action (cross-turn), when known. */
  approvalPending?: boolean;
}

export interface PlanMissingField {
  key: string;
  label: string;
}

export interface PlanState {
  prospectState: ProspectState;
  strategy?: string;
  /** Required-info still missing for the active objective (key + human label). */
  missingRequired: PlanMissingField[];
  /** The objective has been asked-but-unanswered across turns → advance, don't re-ask. */
  stalled: boolean;
  /** Wizard fact: configured qualification signals evidenced (undefined = not gated). */
  qualificationMet?: boolean;
  /** Wizard fact: fit verdict (e.g. "disqualified"). */
  fit?: WizardRuntimeFacts["fit"];
  /** Wizard fact: the configured disqualifier matched this turn, if any. */
  disqualifierMatched?: string;
  calendarBookable?: boolean;
  stepIndex: number;
  chainLength: number;
}

/**
 * The single compact execution plan handed to the model. `bestNextAction` is the
 * top-ranked candidate; `candidateActions` are the ranked alternatives.
 */
export interface CurrentPlan {
  /** Objective mission — the goal in one line. Null when the chain is complete. */
  goal: string | null;
  currentObjective: ObjectiveName | null;
  currentState: PlanState | null;
  bestNextAction: NextActionCandidate | null;
  candidateActions: NextActionCandidate[];
  preferredTool?: string;
  preferredCapability?: string;
  /** 0..1 — score of the best next action. */
  confidence: number;
  /** Why the best next action advances the goal. */
  why: string;
  /** The turn's tool surface, grouped into capabilities. */
  capabilities: CapabilityGroup[];
  /**
   * Did the configured BUSINESS OUTCOME happen — and if not, can it progress?
   * Derived (not persisted) by the Goal Evaluator. Null when the employee has no
   * measurable business outcome → conversation completion is BEL's call, not the
   * goal's. Decoupled from objective navigation and from closure.
   */
  goalStatus: GoalStatus | null;
  /** Goal snapshot to persist for next turn (Goal Ownership). Mirror of the
   *  orchestrator's own commitObjective; exposed so callers can reuse it. */
  snapshot: ActiveGoalSnapshot | null;
}

function labelOf(status: ObjectiveStatus, key: string): string {
  return status.objective.requiredInformation.find((f) => f.key === key)?.label ?? key;
}

/**
 * Compute the current execution plan. Pure; never throws. Reuses the existing
 * objective engine + capability layer — no new state is invented or recomputed.
 */
export function computeCurrentPlan(input: PlanInput): CurrentPlan {
  const wf = input.wizardFacts ?? EMPTY_WIZARD_FACTS;
  const capabilities = groupToolsIntoCapabilities(input.toolFunctionNames, input.toolCapabilityHints);

  const prospectState = computeProspectState(input.prospectFlags);

  // Same derivation the prompt builder did inline — just centralized here.
  const fresh = selectActiveObjective(
    input.role,
    prospectState,
    input.factText,
    input.completedActionTools ?? [],
    input.calendarBookable !== false, // non-bookable agent → don't stall on BOOK_MEETING
    wf.goalObjective, // WIZARD→RUNTIME: configured goal sets the chain endpoint
  );
  const { status, snapshot } = commitObjective(input.priorGoal ?? null, fresh, input.factText);
  const stalled = (snapshot?.stalledTurns ?? 0) >= 2;

  const candidates = resolveNextActions({
    status,
    capability: input.toolFunctionNames ?? [],
    calendarBookable: input.calendarBookable,
    qualificationMet: wf.qualificationMet,
    stalled,
  });
  const best = candidates[0] ?? null;

  // GOAL EVALUATOR (separate concern from navigation): did the configured
  // business OUTCOME happen, and if not can it progress? Pure projection over
  // runtime homes (CRM flags + active-booking) + capability + wizard fit +
  // recovery/approval. Null when the goal has no measurable outcome → BEL owns done.
  const goalObjective = resolveGoalObjective(input.role, wf.goalObjective);
  const goalStatus = evaluateGoalStatus({
    goalObjective,
    presentOutcomes: presentBusinessOutcomes({
      crmFlags: input.prospectFlags,
      hasActiveBooking: input.hasActiveBooking,
    }),
    capabilities: capabilities.map((g) => g.capability),
    fit: wf.fit,
    recovery: input.recovery,
    approvalPending: input.approvalPending,
  });

  const currentState: PlanState | null = status
    ? {
        prospectState,
        strategy: input.strategyName,
        missingRequired: status.missingRequired.map((k) => ({ key: k, label: labelOf(status, k) })),
        stalled,
        qualificationMet: wf.qualificationMet,
        fit: wf.fit,
        disqualifierMatched: wf.disqualifierMatched ?? undefined,
        calendarBookable: input.calendarBookable,
        stepIndex: status.stepIndex,
        chainLength: status.chain.length,
      }
    : null;

  return {
    goal: status?.objective.mission ?? null,
    currentObjective: status?.objective.id ?? null,
    currentState,
    bestNextAction: best,
    candidateActions: candidates,
    preferredTool: best?.tool,
    preferredCapability: best?.tool ? capabilityOfTool(best.tool, input.toolCapabilityHints) : undefined,
    confidence: best?.score ?? 0,
    why: best?.rationale ?? "",
    capabilities,
    goalStatus,
    snapshot,
  };
}

const ACTION_TAG: Record<NextActionKind, string> = {
  act: "ACT",
  propose: "PROPOSE",
  ask: "ASK",
  escalate: "ESCALATE",
};

/**
 * Render the plan as ONE compact "# Current Plan" block — Goal → Situation →
 * Best next action → alternatives → capabilities. Replaces the former six
 * objective/NBA sub-sections and the flat tool list. Reuses the exact imperative
 * action labels the model is already tuned to (from resolveNextActions).
 */
export function renderCurrentPlan(plan: CurrentPlan): string {
  const lines: string[] = ["# Current Plan (decide and ACT this turn)"];

  // ── No active objective to navigate → the GOAL STATUS (not the bare cursor)
  //    decides what to say. This is the decoupling: "no next step" no longer
  //    implies "achieved" or "you may close". ──
  if (!plan.goal || !plan.currentState) {
    const gs = plan.goalStatus;
    const what = (o: string) => o.replace(/_/g, " ");
    if (gs?.kind === "ACHIEVED") {
      lines.push(
        `**Goal achieved:** the ${what(gs.outcome)} is done. Confirm it warmly and wrap with a concrete next step — ` +
          `never a passive "anything else?". (Whether to actually close the chat is a separate call.)`,
      );
    } else if (gs?.kind === "BLOCKED") {
      lines.push(
        `**Goal blocked (${gs.reason}):** the ${what(gs.outcome)} has NOT happened yet and can't progress right now` +
          `${gs.detail ? ` (${gs.detail})` : ""}. Be honest that it's pending, do NOT claim it's done, and keep the customer engaged.`,
      );
    } else if (gs?.kind === "FAILED") {
      if (gs.reason === "disqualified") {
        lines.push(
          `**Not a fit for this goal:** this prospect doesn't qualify for the ${what(gs.outcome)}. Wrap up warmly and ` +
            `politely — do NOT push the ${what(gs.outcome)}, and do NOT escalate; this isn't a human-handoff case.`,
        );
      } else {
        lines.push(
          `**Goal can't be completed right now (${gs.reason}):** ${gs.detail ? gs.detail + ". " : ""}Do NOT claim the ` +
            `${what(gs.outcome)} happened. Be honest that it can't be done this moment and offer that the team will ` +
            `follow up. (Don't call escalate just for this — only if the customer explicitly asks for a human.)`,
        );
      }
    } else if (gs?.kind === "ACTIVE") {
      // The navigation cursor ran out, but the business OUTCOME hasn't happened.
      // This is the case the old ALL_COMPLETE masked — do NOT close; drive it.
      lines.push(
        `**Goal still open:** the ${what(gs.outcome)} has NOT happened yet. Keep driving toward it this turn ` +
          `(propose / book / create), do NOT wrap up or ask "anything else?" — the goal isn't done until the ${what(gs.outcome)} exists.`,
      );
    } else {
      // No measurable business goal → conversation completion is BEL's call.
      // Never a passive closer; end on a concrete next step.
      lines.push(
        "**Goal:** No open business outcome to drive. You may close naturally — clear summary and a concrete next " +
          'step, never a passive "anything else?". If the customer asks for something you have a tool for, still DO it.',
      );
    }
    const caps = renderCapabilities(plan.capabilities);
    if (caps) lines.push("", caps);
    return lines.join("\n");
  }

  const st = plan.currentState;
  lines.push(
    `**Goal:** ${plan.goal} _(objective ${plan.currentObjective}, step ${st.stepIndex + 1}/${st.chainLength})_`,
  );

  // Situation — who this is + the strategic posture, in one line.
  const sit: string[] = [st.prospectState];
  if (st.strategy) sit.push(`${st.strategy} strategy`);
  if (st.qualificationMet === true) sit.push("qualified");
  else if (st.qualificationMet === false) sit.push("still qualifying");
  if (st.calendarBookable === false) sit.push("cannot book a meeting this conversation");
  lines.push(`**Situation:** ${sit.join(", ")}.`);

  // Goal health (separate from navigation): if the business outcome is blocked or
  // unreachable, say so honestly even while we keep driving the objective.
  const gs = plan.goalStatus;
  if (gs?.kind === "BLOCKED") {
    lines.push(
      `⏳ **Goal pending (${gs.reason}):** the ${gs.outcome.replace(/_/g, " ")} hasn't landed yet` +
        `${gs.detail ? ` (${gs.detail})` : ""}. Don't claim it's done; tell the customer honestly it's in progress.`,
    );
  } else if (gs?.kind === "FAILED" && gs.reason !== "disqualified") {
    // disqualified is handled by the qualify-out directive below — not a handoff.
    lines.push(
      `🚫 **Goal can't be completed right now (${gs.reason}):** ${gs.detail ? gs.detail + ". " : ""}don't claim the ${gs.outcome.replace(/_/g, " ")} happened; be honest it can't be done this moment and offer that the team will follow up. Don't escalate unless the customer asks for a human.`,
    );
  }

  // What's still needed — the objective ledger, compressed.
  if (st.missingRequired.length > 0) {
    lines.push(`**Still needed for the goal:** ${st.missingRequired.map((m) => m.label).join("; ")}.`);
  } else {
    lines.push("**Still needed for the goal:** nothing — every required detail is captured. Act, don't re-ask.");
  }

  // Hard ordering: a later objective is LOCKED until this one completes. Prevents
  // jumping ahead (e.g. booking/creating a deal before qualifying).
  if (st.stepIndex < st.chainLength - 1) {
    lines.push(
      "⛔ Work ONLY this goal now. Do NOT jump ahead to a later step (e.g. proposing/booking a meeting, or " +
        "creating a deal) until this one is complete — jumping ahead is a failure.",
    );
  }

  // Wizard fit: graceful qualify-out (reuses the existing directive verbatim).
  if (st.fit === "disqualified" && st.disqualifierMatched) {
    lines.push("", renderQualifyOutDirective(st.disqualifierMatched));
  }

  // The decision: best next action, then ranked alternatives.
  if (plan.bestNextAction) {
    const b = plan.bestNextAction;
    lines.push("");
    lines.push(`**Best next action → [${ACTION_TAG[b.kind]}]** ${b.label}`);
    lines.push(`_Why:_ ${b.rationale} _(confidence ${plan.confidence.toFixed(2)})_`);
    lines.push(
      "Pick the ONE move that best fits what the customer just said and DO it this turn — call the tool or ask the one question. Prefer an [ACT]/[PROPOSE] over talking when you already have what you need.",
    );
    const rest = plan.candidateActions.slice(1);
    if (rest.length > 0) {
      lines.push("");
      lines.push("**Other options (best first):**");
      rest.forEach((c, i) => lines.push(`${i + 2}. [${ACTION_TAG[c.kind]}] ${c.label}`));
    }
  }

  const caps = renderCapabilities(plan.capabilities);
  if (caps) {
    lines.push("");
    lines.push(caps);
  }

  return lines.join("\n");
}
