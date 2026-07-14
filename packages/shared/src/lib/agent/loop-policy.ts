/**
 * Agent Loop - policy & bounds (pure, capability-composable).
 *
 * The loop is NOT bounded by one global iteration cap. Each Capability declares
 * its own loop policy (a WRITE-heavy or destructive capability may allow fewer
 * iterations or a tighter budget than a read-only one). The effective policy for
 * a turn is the TIGHTEST of the platform default and every ENGAGED capability's
 * stated limit - capabilities may only tighten safety, never loosen it.
 *
 * Nothing here decides; it only computes the envelope the driver enforces.
 */

/** Why a loop stopped - every run persists exactly one of these. */
export type TerminationReason =
  // ── Reasoner-chosen (judgment) ──
  | "finish" // goal reached / nothing left to do
  | "need_input" // must ask the customer the one blocking thing
  | "escalate" // Reasoner judges it is stuck → human
  | "converse" // non-executing turn (CONVERSE/WAIT) → treated as finish
  // ── Guard-forced (resource envelope) ──
  | "max_iterations"
  | "timeout"
  | "budget_exceeded"
  // ── Runtime-forced ──
  | "awaiting_approval" // a human must approve an operation
  | "blocked" // runtime refused with no recoverable route
  | "failed" // unrecoverable failure
  // ── Ownership-forced ──
  | "superseded"; // a human took the conversation over mid-loop → stand down silently

export interface LoopPolicy {
  /** Hard ceiling on reason→execute cycles. */
  maxIterations: number;
  /** Wall-clock ceiling for the whole loop, ms. */
  maxWallMs: number;
  /** AI-unit ceiling for the whole loop (billing enforcement is the real backstop). */
  maxBudgetUnits: number;
}

/** Platform default envelope - the loosest allowed; capabilities only tighten it. */
export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  maxIterations: 6,
  maxWallMs: 60_000,
  maxBudgetUnits: Number.POSITIVE_INFINITY,
};

/** A capability's stated limits - any omitted field inherits the default. */
export type CapabilityLoopPolicy = Partial<LoopPolicy>;

/**
 * Compose the effective policy: TIGHTEN-ONLY. For each bound, take the minimum of
 * the base and every engaged capability's stated value. Pure, total.
 */
export function resolveLoopPolicy(
  base: LoopPolicy,
  engaged: CapabilityLoopPolicy[],
): LoopPolicy {
  return engaged.reduce<LoopPolicy>(
    (acc, p) => ({
      maxIterations: Math.min(acc.maxIterations, p.maxIterations ?? Number.POSITIVE_INFINITY),
      maxWallMs: Math.min(acc.maxWallMs, p.maxWallMs ?? Number.POSITIVE_INFINITY),
      maxBudgetUnits: Math.min(acc.maxBudgetUnits, p.maxBudgetUnits ?? Number.POSITIVE_INFINITY),
    }),
    { ...base },
  );
}
