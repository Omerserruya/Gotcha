/**
 * Working Memory - the Agent Loop's evolving intra-loop scratchpad.
 *
 * Distinct from `AgentMemory` (cross-TURN continuity, advisory, fed back next
 * conversation turn). Working Memory is INTRA-LOOP: it is born when a loop starts
 * and dies when it terminates. It captures what the Agent has learned WHILE
 * reasoning toward a goal across iterations - established facts, operations it has
 * tried and ruled out, questions still open, and working hypotheses - so each
 * iteration reasons from an accumulating understanding, not a flat replay of the
 * last observation.
 *
 * Trust: Working Memory is NOT authoritative. FACTS (the Oracle) always override
 * it. `establishedFacts`/`ruledOut`/`iterations` are maintained DETERMINISTICALLY
 * by the loop from real observations (trustworthy); `hypotheses`/`openQuestions`
 * are the Reasoner's own notes (advisory). Bounded so it can't grow unbounded.
 */

import type { BusinessOutcome } from "./memory";
import type { ReasonerDecision } from "./cognition";

/** One completed loop iteration - the episodic trail (deterministic, from observations). */
export interface IterationTrace {
  iteration: number;
  /** The decision the Reasoner committed this iteration. */
  decision: ReasonerDecision;
  /** The operation proposed (EXECUTE only), for repeat/ruled-out tracking. */
  proposedOperation?: string;
  /** Neutral projection of what the Runtime observed (status + one-line outcome). */
  observation?: string;
  /** Terminal ExecutionResult status if an operation ran (EXECUTED/FAILED/…). */
  runtimeResult?: string;
}

/** An operation attempted and abandoned, with the reason it won't be retried. */
export interface RuledOutOperation {
  operation: string;
  why: string;
}

export interface WorkingMemory {
  /** The outcome this loop is driving toward (from mission/committedGoal). */
  goal: BusinessOutcome | null;
  /** World-state truths confirmed DURING the loop (deterministic, from Facts deltas). */
  establishedFacts: string[];
  /** Operations tried and abandoned - the loop will not re-propose these blindly. */
  ruledOut: RuledOutOperation[];
  /** What is still unknown/blocking - sourced from the Reasoner's missingInformation. */
  openQuestions: string[];
  /** Working beliefs that are NOT Facts (advisory, Reasoner-authored). */
  hypotheses: string[];
  /** The episodic per-iteration trail. */
  iterations: IterationTrace[];
}

const MAX_LIST = 12;
const MAX_ITERATIONS_KEPT = 20;

/** Empty working memory for a fresh loop toward `goal`. */
export function emptyWorkingMemory(goal: BusinessOutcome | null): WorkingMemory {
  return { goal, establishedFacts: [], ruledOut: [], openQuestions: [], hypotheses: [], iterations: [] };
}

function boundedUnique(existing: string[], incoming: string[], cap = MAX_LIST): string[] {
  const out = [...existing];
  for (const s of incoming) {
    const v = (s ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(-cap);
}

/**
 * Merge one iteration's learnings into Working Memory. Pure, total, bounded.
 *  - establishedFacts / openQuestions / hypotheses accumulate (deduped, bounded);
 *  - ruledOut is keyed by operation (later reason wins);
 *  - iterations append (rolling window).
 */
export function mergeWorkingMemory(
  wm: WorkingMemory,
  patch: {
    establishedFacts?: string[];
    openQuestions?: string[];
    hypotheses?: string[];
    ruledOut?: RuledOutOperation[];
    iteration?: IterationTrace;
  },
): WorkingMemory {
  const ruledOut = [...wm.ruledOut];
  for (const r of patch.ruledOut ?? []) {
    const op = (r.operation ?? "").trim();
    if (!op) continue;
    const idx = ruledOut.findIndex((x) => x.operation === op);
    if (idx >= 0) ruledOut[idx] = { operation: op, why: r.why };
    else ruledOut.push({ operation: op, why: r.why });
  }

  return {
    goal: wm.goal,
    establishedFacts: boundedUnique(wm.establishedFacts, patch.establishedFacts ?? []),
    openQuestions: boundedUnique([], patch.openQuestions ?? wm.openQuestions), // openQuestions REPLACE (they close as answered)
    hypotheses: boundedUnique(wm.hypotheses, patch.hypotheses ?? []),
    ruledOut: ruledOut.slice(-MAX_LIST),
    iterations: (patch.iteration ? [...wm.iterations, patch.iteration] : wm.iterations).slice(-MAX_ITERATIONS_KEPT),
  };
}
