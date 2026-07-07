/**
 * Agent Loop persistence — every iteration and every run is recorded so the loop
 * is fully observable and replayable (the same corpus philosophy as the reasoner
 * shadow evals). Writes are guarded: a persistence failure must NEVER break the
 * loop or the customer turn.
 *
 * Two tables:
 *   agent_loop_runs        — one row per loop (goal, termination, totals, reply).
 *   agent_loop_iterations  — one row per iteration (oracle snapshot, reasoning,
 *                            proposed operation, runtime result, observation).
 *
 * ORDERING CONTRACT: `agent_loop_iterations.loop_id` is a FK to `agent_loop_runs`,
 * so the run row MUST exist before the first iteration is written. The run is
 * therefore CREATED up front (`startLoopRun`, placeholder finals) and FINALIZED at
 * the end (`finalizeLoopRun`). This also makes an in-flight run observable and
 * survives a mid-loop crash (the row + its iterations persist).
 */

import { prisma } from "@chatcenter/shared";

export interface LoopIterationRecord {
  loopId: string;
  tenantId: string;
  conversationId: string;
  iteration: number;
  goal: string | null;
  /** Provider-neutral Facts snapshot the Reasoner saw (replayable). */
  oracleFactsSnapshot: unknown;
  /** Short WHY from the Reasoner read (situation/rationale) — audit only. */
  reasoningSummary: string;
  decisionType: string;
  proposedOperation: string | null;
  proposedParams: unknown;
  /** ExecutionResult status if an operation ran this iteration. */
  runtimeResult: string | null;
  /** Neutral Observation projection (status/outcome/reason/invariants). */
  observation: unknown | null;
  /** Goal-relevant Facts signature hash — powers goal-based progress detection. */
  factsSignature: string | null;
  progressed: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}

export interface LoopRunRecord {
  loopId: string;
  tenantId: string;
  conversationId: string;
  turnId: string;
  agentId?: string;
  goal: string | null;
  terminationReason: string;
  iterationCount: number;
  spentUnits: number;
  wallMs: number;
  mode: string;
  finalDecision: unknown;
  finalReplyIntent: unknown;
  reply: string | null;
  provider: string;
  model: string;
  promptVersion: string;
}

export async function persistLoopIteration(r: LoopIterationRecord): Promise<void> {
  try {
    await (prisma as any).agentLoopIteration.create({
      data: {
        loopId: r.loopId,
        tenantId: r.tenantId,
        conversationId: r.conversationId,
        iteration: r.iteration,
        goal: r.goal,
        oracleFactsSnapshot: r.oracleFactsSnapshot as any,
        reasoningSummary: r.reasoningSummary,
        decisionType: r.decisionType,
        proposedOperation: r.proposedOperation,
        proposedParams: r.proposedParams as any,
        runtimeResult: r.runtimeResult,
        observation: r.observation as any,
        factsSignature: r.factsSignature,
        progressed: r.progressed,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        latencyMs: r.latencyMs,
      },
    });
  } catch (e: any) {
    console.warn("[agent-loop] persist iteration failed:", e?.message ?? e);
  }
}

/** Identity/provenance known at loop start — enough to satisfy the iteration FK. */
export interface LoopRunStart {
  loopId: string;
  tenantId: string;
  conversationId: string;
  turnId: string;
  agentId?: string;
  goal: string | null;
  mode: string;
  provider: string;
  model: string;
  promptVersion: string;
}

/**
 * Create the run row BEFORE the first iteration so the FK holds. Finalization
 * fields carry placeholders ("running") until `finalizeLoopRun` overwrites them.
 */
export async function startLoopRun(r: LoopRunStart): Promise<void> {
  try {
    await (prisma as any).agentLoopRun.create({
      data: {
        loopId: r.loopId,
        tenantId: r.tenantId,
        conversationId: r.conversationId,
        turnId: r.turnId,
        agentId: r.agentId,
        goal: r.goal,
        terminationReason: "running",
        iterationCount: 0,
        spentUnits: 0,
        wallMs: 0,
        mode: r.mode,
        finalDecision: {},
        finalReplyIntent: {},
        reply: null,
        provider: r.provider,
        model: r.model,
        promptVersion: r.promptVersion,
      },
    });
  } catch (e: any) {
    console.warn("[agent-loop] start run failed:", e?.message ?? e);
  }
}

/** Overwrite the placeholder finals with the real outcome (keyed by unique loopId). */
export async function finalizeLoopRun(r: LoopRunRecord): Promise<void> {
  try {
    await (prisma as any).agentLoopRun.update({
      where: { loopId: r.loopId },
      data: {
        goal: r.goal,
        terminationReason: r.terminationReason,
        iterationCount: r.iterationCount,
        spentUnits: r.spentUnits,
        wallMs: r.wallMs,
        finalDecision: r.finalDecision as any,
        finalReplyIntent: r.finalReplyIntent as any,
        reply: r.reply,
      },
    });
  } catch (e: any) {
    console.warn("[agent-loop] finalize run failed:", e?.message ?? e);
  }
}
