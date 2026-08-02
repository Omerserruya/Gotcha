/**
 * Agent Loop - pure control logic (no I/O).
 *
 * The loop enforces ONLY safety/resource envelopes; it makes NO business decision.
 * It never judges progress, never decides to stop or continue on business grounds
 * - those belong exclusively to the Reasoner (which sees the observations, the
 * ruled-out operations, and the working plan, and chooses ASK / ESCALATE / FINISH).
 *
 * This module owns: the DECISION→CONTROL mapping, the resource-bound checks
 * (iterations / wall-time / budget), and which runtime outcomes are genuine
 * boundaries. It knows NO domain and NO business goal.
 */

import type { ReasonerDecision } from "./cognition";
import type { LoopPolicy, TerminationReason } from "./loop-policy";

/** What the driver should do with a Reasoner decision. */
export type LoopControl =
  | { kind: "propose"; operation: string; params: Record<string, unknown> }
  | { kind: "terminate"; reason: TerminationReason };

/**
 * Map a Reasoner decision to loop control. EXECUTE is the ONLY continuing move
 * (its observation re-enters); every other decision terminates the loop.
 */
export function decisionToControl(d: ReasonerDecision): LoopControl {
  switch (d.type) {
    case "EXECUTE":
      return { kind: "propose", operation: d.operation, params: d.params };
    case "REQUEST_INPUT":
      return { kind: "terminate", reason: "need_input" };
    case "FINISH":
      return { kind: "terminate", reason: "finish" };
    case "ESCALATE":
      return { kind: "terminate", reason: "escalate" };
    case "CONVERSE":
    case "WAIT":
    default:
      return { kind: "terminate", reason: "converse" };
  }
}

/**
 * Resource envelope - checked BEFORE each reason() call. Returns the termination
 * reason if a hard RESOURCE bound is exceeded, else null. These are pure resource
 * ceilings (cost/latency safety), NOT business judgments about the work.
 */
export function preReasonTermination(
  s: { iteration: number; elapsedMs: number; spentUnits: number },
  policy: LoopPolicy,
): TerminationReason | null {
  if (s.iteration > policy.maxIterations) return "max_iterations";
  if (s.elapsedMs >= policy.maxWallMs) return "timeout";
  if (s.spentUnits >= policy.maxBudgetUnits) return "budget_exceeded";
  return null;
}

/**
 * Map a Runtime ExecutionResult status to a FORCED termination, or null to let
 * the observation re-enter the loop.
 *
 * ONLY two runtime outcomes end the loop: AWAITING_APPROVAL (a genuine async
 * boundary - a human must act before anything can proceed) and an unrecoverable
 * FAILED. Everything else - including BLOCKED and guardrail denials - RE-ENTERS:
 * the loop must NOT decide to give up; the Reasoner re-reasons and chooses ASK /
 * ESCALATE / an alternative / FINISH. Runaway is bounded by max-iterations/time.
 */
export function runtimeResultToTermination(
  status: string,
  recoverable: boolean | undefined,
): TerminationReason | null {
  switch (status) {
    case "AWAITING_APPROVAL":
      return "awaiting_approval";
    case "FAILED":
      return recoverable ? null : "failed";
    case "BLOCKED":
    default:
      return null;
  }
}
