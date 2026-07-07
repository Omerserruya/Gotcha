/**
 * Shadow evaluation — Planner decision ↔ Reasoner decision, over the SAME Oracle
 * Facts.
 *
 * The Planner is a MIGRATION ORACLE only: a temporary baseline we compare the
 * Reasoner against until parity is proven, then delete. Nothing here improves the
 * Planner — the adapter translates its output INTO the Reasoner's decision
 * vocabulary (the permanent target), which is a step toward retiring it.
 *
 * Pure, deterministic, zero deps, never throws. The live shadow runner (services/
 * ai) computes both decisions per turn and persists `ShadowEvalRecord`s; this
 * module owns only the translation + diff so "did they agree?" is defined once.
 */

import type { ReasonerDecision, ReasonerInput } from "./cognition";

/**
 * Schema version of a corpus record. BUMP when the record shape changes so
 * historical rows stay interpretable and replayable against future models.
 */
export const SHADOW_EVAL_SCHEMA_VERSION = 1;

/**
 * The minimal shape of a Planner's chosen move — decoupled from services/ai's
 * `NextActionCandidate` on purpose (shared imports nothing from the Planner it is
 * helping to delete). The shadow runner maps the real candidate into this.
 */
export interface PlannerMove {
  /** Planner's `NextActionKind`, plus "none" for "no action / just talk". */
  kind: "act" | "propose" | "ask" | "escalate" | "none";
  /** The operation the Planner would run (act/propose), in operation vocabulary. */
  operation?: string;
  /** The required-info field the Planner would ask for (ask). */
  field?: string;
}

/**
 * Translate a Planner move into the canonical Reasoner decision vocabulary. This
 * is the one bridge from the temporary Planner to the permanent contract.
 *   act | propose → EXECUTE   ·   ask → REQUEST_INPUT   ·   escalate → ESCALATE
 *   none → CONVERSE (talk this turn; WAIT is reserved for explicit "do nothing").
 */
export function plannerMoveToDecision(move: PlannerMove): ReasonerDecision {
  switch (move.kind) {
    case "act":
    case "propose":
      return { type: "EXECUTE", operation: move.operation ?? "", params: {} };
    case "ask":
      return { type: "REQUEST_INPUT", needed: move.field ?? "" };
    case "escalate":
      return { type: "ESCALATE", reason: "planner_escalate" };
    case "none":
    default:
      return { type: "CONVERSE" };
  }
}

export type DivergenceAxis = "none" | "move_type" | "operation" | "field";

export interface DecisionDivergence {
  /** Do the two decisions agree on the meaningful axis? */
  agree: boolean;
  /** Same discriminated move type (EXECUTE vs REQUEST_INPUT vs …). */
  moveTypeMatch: boolean;
  /** Same detail where the move type carries one (operation / needed field). */
  detailMatch: boolean;
  /** Where the primary divergence is (for bucketed analytics). */
  axis: DivergenceAxis;
}

/**
 * Compare two decisions in the SAME vocabulary. Agreement = same move type AND
 * (for EXECUTE) same operation AND (for REQUEST_INPUT) same needed field. Reasons
 * (ESCALATE) and phrasing are intentionally NOT compared — only the decision.
 */
export function compareDecisions(
  planner: ReasonerDecision,
  reasoner: ReasonerDecision,
): DecisionDivergence {
  const moveTypeMatch = planner.type === reasoner.type;
  if (!moveTypeMatch) {
    return { agree: false, moveTypeMatch: false, detailMatch: false, axis: "move_type" };
  }

  if (planner.type === "EXECUTE" && reasoner.type === "EXECUTE") {
    const detailMatch = planner.operation === reasoner.operation;
    return { agree: detailMatch, moveTypeMatch: true, detailMatch, axis: detailMatch ? "none" : "operation" };
  }
  if (planner.type === "REQUEST_INPUT" && reasoner.type === "REQUEST_INPUT") {
    const detailMatch = planner.needed === reasoner.needed;
    return { agree: detailMatch, moveTypeMatch: true, detailMatch, axis: detailMatch ? "none" : "field" };
  }
  // CONVERSE / ESCALATE / WAIT — same move type is full agreement.
  return { agree: true, moveTypeMatch: true, detailMatch: true, axis: "none" };
}

/**
 * A single row of the PERMANENT evaluation corpus — provider-neutral and
 * replayable. This is not a shadow log; it is a dataset for prompt eval,
 * regression detection, model comparison, fine-tuning, Planner-retirement
 * decisions, and future automated evals.
 *
 * REPLAY: `reasonerInput` is the full, vendor-neutral input both decisions were
 * computed over — so a future model (GPT-6, Claude, …) can be re-run against the
 * exact same inputs and compared. NEVER store provider request/response; that
 * stays behind the ReasonerProvider boundary.
 */
export interface ShadowEvalRecord {
  /** Stable-schema marker for cross-version replay. */
  schemaVersion: number;
  /** ISO capture time. */
  createdAt: string;

  tenantId: string;
  conversationId: string;
  /** Stable per-turn id (idempotency + join key). */
  turnId: string;
  agentId?: string;

  /** The replayable, provider-neutral input (Facts + Context + Memory). */
  reasonerInput: ReasonerInput;

  /** Both decisions in the ONE canonical vocabulary. */
  plannerDecision: ReasonerDecision;
  reasonerDecision: ReasonerDecision;
  /** Agreement classification + divergence axis. */
  divergence: DecisionDivergence;

  // ── Live-turn correlation (the Planner drove production; nullable/backfilled) ──
  /** The operation that actually executed this turn, if any. */
  executedOperation?: string;
  /** The Runtime result status of what actually executed (ExecutionResult.status). */
  runtimeResult?: string;
  /** Eventual business outcome, backfilled later (e.g. a booking that landed). */
  finalBusinessOutcome?: string;

  // ── Provenance / eval axes (provider-neutral) ──
  provider: string;
  model: string;
  /** Version of the reasoning prompt/strategy — the key regression axis. */
  promptVersion: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;

  /** The Reasoner's untrusted rationale (audit/eval only, never executed). */
  reasoningTrace?: string;
  /** Open, forward-compatible bag for future eval dimensions. */
  metadata?: Record<string, unknown>;
}

/** Aggregate agreement stats over a batch — for the eval dashboard. Pure. */
export function summarizeShadowBatch(records: ShadowEvalRecord[]): {
  total: number;
  agreementRate: number;
  byAxis: Record<DivergenceAxis, number>;
} {
  const byAxis: Record<DivergenceAxis, number> = { none: 0, move_type: 0, operation: 0, field: 0 };
  let agreed = 0;
  for (const r of records) {
    if (r.divergence.agree) agreed++;
    byAxis[r.divergence.axis]++;
  }
  const total = records.length;
  return { total, agreementRate: total ? agreed / total : 1, byAxis };
}
