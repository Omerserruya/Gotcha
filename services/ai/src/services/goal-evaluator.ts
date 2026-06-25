/**
 * Goal Evaluator.
 *
 * Answers ONE question, and only that question: **did the configured business
 * outcome actually happen — and if not, can it still progress?** It does NOT
 * decide what to do next (Objective Engine) and does NOT decide whether to close
 * the conversation (BEL). Those stay separate by design.
 *
 * It is a PURE PROJECTION over runtime truth the runtime already holds — CRM
 * presence flags, the active-booking flag, the live Outcome Ledger, the
 * capability surface, the recovery (Unit C) signal, and approval state. It never
 * persists anything, never reconstructs from the audit, and never branches on
 * objective IDs (all per-domain knowledge is data: the objective's `outcome`
 * signature). Fixed precedence, so it can't grow its own rule engine.
 *
 * Scope: GoalStatus exists ONLY for measurable business outcomes. When the
 * configured goal endpoint has no `outcome` signature (a navigation-only
 * employee), this returns `null` and BEL owns "done" entirely.
 */

import { OBJECTIVES, type BusinessOutcome, type ObjectiveName } from "./objectives";
import { capabilityForOutcome } from "./capabilities";
import type { CrmStateFlags } from "./prospect-state";
import type { LedgerEntry } from "./turn-outcome-ledger";

export type GoalStatusKind = "ACTIVE" | "ACHIEVED" | "BLOCKED" | "FAILED";

export type GoalBlockReason =
  | "awaiting_approval"
  | "external_failure"
  | "missing_capability"
  | "recovery_exhausted"
  | "disqualified";

export interface GoalStatus {
  kind: GoalStatusKind;
  /** The configured goal objective (chain endpoint). */
  goal: ObjectiveName;
  /** The business outcome that defines achievement. */
  outcome: BusinessOutcome;
  /** Why it's BLOCKED/FAILED (absent for ACTIVE/ACHIEVED). */
  reason?: GoalBlockReason;
  /** Human-facing one-liner, e.g. "needs CALENDAR". */
  detail?: string;
}

export interface RecoverySignal {
  /** A goal-advancing action failed but recovery is still trying (retry/alt/ask). */
  active?: boolean;
  /** Recovery tried everything; the action can't be completed this conversation. */
  exhausted?: boolean;
}

export interface GoalEvalInput {
  /** Resolved configured goal = the (truncated) chain endpoint. null → no goal. */
  goalObjective: ObjectiveName | null;
  /** Business outcomes that exist in their runtime homes right now. */
  presentOutcomes: ReadonlySet<BusinessOutcome>;
  /** Capability keys available this turn (from the Capability Layer). */
  capabilities: string[];
  /** Wizard fit verdict. */
  fit?: "qualified" | "disqualified" | "neutral";
  /** Recovery (Unit C) signal for the goal's action. */
  recovery?: RecoverySignal;
  /** An approval is pending on the goal's action (ApprovalRequest / ledger pending_approval). */
  approvalPending?: boolean;
}

/**
 * Project the business outcomes that EXIST right now, from runtime state the
 * runtime already holds: CRM presence flags, the active-booking flag, and any
 * outcomes the live ledger committed THIS turn. No audit, no reconstruction.
 */
export function presentBusinessOutcomes(opts: {
  crmFlags?: CrmStateFlags | null;
  hasActiveBooking?: boolean;
  liveOutcomes?: Iterable<BusinessOutcome>;
}): Set<BusinessOutcome> {
  const s = new Set<BusinessOutcome>();
  const f = opts.crmFlags;
  if (f?.hasLead) s.add("crm_lead");
  if (f?.hasContact) s.add("crm_contact");
  if (f?.hasOpportunity) s.add("crm_deal");
  if (opts.hasActiveBooking) s.add("booking");
  for (const o of opts.liveOutcomes ?? []) s.add(o);
  return s;
}

/**
 * Map the live ledger's committed/succeeded customer-facing entries to business
 * outcomes — for the post-action re-evaluation (a booking/lead that landed THIS
 * turn). Pure; reads the ledger's own kind/externalRef, no new representation.
 */
export function businessOutcomesFromLedger(entries: LedgerEntry[]): BusinessOutcome[] {
  const out: BusinessOutcome[] = [];
  for (const e of entries) {
    if (e.status !== "committed" && e.status !== "succeeded_unverified") continue;
    const ref = e.externalRef?.type ?? "";
    if (e.kind === "booking" || ref === "gcal_event") out.push("booking");
    else if (ref === "crm_lead") out.push("crm_lead");
    else if (ref === "crm_contact") out.push("crm_contact");
    else if (ref === "crm_deal" || ref === "deal") out.push("crm_deal");
  }
  return out;
}

/**
 * Evaluate the goal. Returns null when there is no measurable business goal —
 * then conversation completion is BEL's responsibility, not GoalStatus's.
 */
export function evaluateGoalStatus(input: GoalEvalInput): GoalStatus | null {
  const { goalObjective } = input;
  if (!goalObjective) return null;
  const outcome = OBJECTIVES[goalObjective]?.outcome;
  if (!outcome) return null; // navigation endpoint — no business outcome to measure

  const base = { goal: goalObjective, outcome } as const;

  // 1) ACHIEVED — the business outcome exists in its runtime home.
  if (input.presentOutcomes.has(outcome)) return { kind: "ACHIEVED", ...base };

  // 2) FAILED — cannot be achieved without a strategy change / handoff.
  if (input.fit === "disqualified") return { kind: "FAILED", reason: "disqualified", ...base };
  if (input.recovery?.exhausted) return { kind: "FAILED", reason: "recovery_exhausted", ...base };
  const neededCap = capabilityForOutcome(outcome);
  if (neededCap && !input.capabilities.includes(neededCap)) {
    return { kind: "FAILED", reason: "missing_capability", detail: `needs ${neededCap}`, ...base };
  }

  // 3) BLOCKED — valid, but can't progress right now (recoverable).
  if (input.approvalPending) return { kind: "BLOCKED", reason: "awaiting_approval", ...base };
  if (input.recovery?.active) return { kind: "BLOCKED", reason: "external_failure", ...base };

  // 4) ACTIVE — default: keep driving the goal.
  return { kind: "ACTIVE", ...base };
}

/**
 * Corrective for the passive-close backstop when the reply tried to wrap up but
 * the business OUTCOME hasn't happened yet (ACTIVE) or is pending (BLOCKED).
 * FAILED is intentionally NOT corrected here — there, expectation-setting /
 * handoff is the right move, not "keep driving".
 */
export function buildGoalPendingCorrective(gs: GoalStatus): string {
  const what = gs.outcome.replace(/_/g, " ");
  if (gs.kind === "BLOCKED") {
    return (
      `**STOP — don't wrap up.** The ${what} (your goal) hasn't happened yet; it's pending (${gs.reason}). ` +
      `Do NOT close or say "anything else?". Tell the customer honestly it's in progress and keep them engaged. ` +
      `Reply in the customer's language. One move only.`
    );
  }
  return (
    `**STOP — don't wrap up.** The ${what} (your goal) hasn't happened yet. Do NOT close or say "anything else?". ` +
    `Make ONE concrete move toward it now — propose, book, or create it — or ask the single question that unblocks it. ` +
    `Reply in the customer's language. One move only.`
  );
}
