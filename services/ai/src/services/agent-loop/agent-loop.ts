/**
 * Agent Loop - the autonomous reasoning engine (control flow ONLY).
 *
 *   Oracle → Reasoner → Decision → Runtime → Observation → Oracle updates → …
 *
 * The loop owns NONE of the four powers it coordinates:
 *   - REASONING stays in the ReasonerProvider (getReasonerProvider()).
 *   - EXECUTION stays in the Capability Runtime (executeOperation → resolveExecution);
 *     the loop proposes, it never touches a tool.
 *   - TRUTH stays in the Oracle (assembleOracleFacts); the loop re-reads Facts each
 *     iteration, it never trusts an operation's return value.
 *   - EXPRESSION stays in the Writer, invoked exactly once at the end.
 *
 * The loop is capability-agnostic: it asks the registry for the Operation Menu and
 * may only PROPOSE from it. Adding a capability never changes this file.
 *
 * Bounded by a composed per-capability policy (iterations / wall-time / budget /
 * goal-based progress) and fully observable (every iteration persisted).
 */

import { randomUUID, createHash } from "crypto";
import {
  DEFAULT_LOOP_POLICY,
  resolveLoopPolicy,
  decisionToControl,
  preReasonTermination,
  runtimeResultToTermination,
  authorizeOperation,
  emptyWorkingMemory,
  mergeWorkingMemory,
  type WorkingMemory,
  type IterationTrace,
  type TerminationReason,
  type ReasonerInput,
  type ReasonerDecision,
  type ReplyIntent,
  type Context,
  type AgentMemory,
  type AgentPersona,
  type BusinessOutcome,
  type KernelSignals,
  type ExecutionRequest,
  type ExecutionContext,
} from "@chatcenter/shared";

import { getReasonerProvider } from "../reasoner";
import { assembleOracleFacts } from "./oracle-assembler";
import type { ToolGrants } from "./permissions-bridge";
import {
  ensureCapabilitiesRegistered,
  executeOperation,
  engagedLoopPolicies,
  type CapabilityContext,
} from "../capability-plane";
import { projectObservation, observationLine } from "./observation";
import { writeReply } from "./writer";
import { persistLoopIteration, startLoopRun, finalizeLoopRun } from "./persistence";

/** The reasoning-strategy version for this loop (persistence provenance / regression axis). */
export const LOOP_PROMPT_VERSION = "agent-loop-v0.1";

/**
 * Stable signature of the world-relevant Facts (menu + domain world), excluding
 * `asOf` so an unchanged world hashes identically across re-reads. Used ONLY for
 * progress observability + anti-stall bookkeeping - never for decisions.
 */
function signatureOfFacts(f: { availableOperations: { name: string }[]; world: unknown }): string {
  const body = JSON.stringify({ menu: f.availableOperations.map((o) => o.name), world: f.world });
  return createHash("sha1").update(body).digest("hex").slice(0, 16);
}

export interface AgentLoopInputs {
  tenantId: string;
  conversationId: string;
  turnId: string;
  aiAgentId?: string;
  customerExternalId?: string;
  customerEmail?: string;
  /** "advisory" (writes → RECOMMENDED, dry-run) or "autonomous" (real execution). */
  mode: "advisory" | "dry_run" | "autonomous";

  /** Oracle base slices the turn owns (identity + RBAC-permitted operations). */
  customer: KernelSignals["customer"];
  permissions: KernelSignals["permissions"];
  /**
   * The agent's tool grants (RBAC home). When set, the Oracle derives the
   * allow-list from these against the live world each tick; `permissions`
   * is then only a fallback ceiling for grant-less principals.
   */
  grants?: ToolGrants;

  /** Reasoner interpretive material. */
  transcript: Context["transcript"];
  mission: Context["mission"];
  goal: BusinessOutcome | null;
  guidance?: string;
  memory: AgentMemory;
  persona?: AgentPersona;
  language?: string;

  signal?: AbortSignal;
  /**
   * Ownership probe, checked between iterations and before every EXECUTE.
   * Returns false when the loop must stand down (a human took the
   * conversation over mid-loop). Injected by the adapter; a probe failure
   * is treated as "still owned" (fail-open) so a transient DB error never
   * kills a healthy turn.
   */
  ownershipCheck?: () => Promise<boolean>;
  /**
   * Production migration guard (P1-4), injected by the adapter. Given a
   * proposed operation, returns the execution mode the loop should actually
   * use for it - the adapter supplies the OPERATION_STATUS ledger so an
   * op not yet PROVEN autonomous dry-runs even inside an autonomous turn.
   * Absent (tests / hermetic runs) ⇒ the loop honours `mode` verbatim, so a
   * capability driven directly still executes for real.
   */
  operationExecutionMode?: (operation: string, requestedMode: AgentLoopInputs["mode"]) => AgentLoopInputs["mode"];
}

export interface AgentLoopResult {
  loopId: string;
  terminationReason: TerminationReason;
  iterations: number;
  /** The ONE customer-facing message (from the Writer), or null if none produced. */
  reply: string | null;
  finalDecision: ReasonerDecision;
  goal: BusinessOutcome | null;
  spentUnits: number;
  wallMs: number;
  workingMemory: WorkingMemory;
  /**
   * The Reasoner's carried-forward conclusions from its LAST reason() call -
   * "becomes next turn's `memory` input" (advisory continuity). Null when the
   * loop terminated before any reasoning happened.
   */
  memoryUpdate: AgentMemory | null;
}

/**
 * Run the autonomous reasoning loop. Never throws - a Reasoner/Runtime failure is
 * turned into an observable termination, and the Writer always produces a reply.
 */
export async function runAgentLoop(inp: AgentLoopInputs): Promise<AgentLoopResult> {
  ensureCapabilitiesRegistered();

  const loopId = randomUUID();
  const provider = getReasonerProvider();
  const startedAt = Date.now();

  const capCtx: CapabilityContext = {
    tenantId: inp.tenantId,
    conversationId: inp.conversationId,
    aiAgentId: inp.aiAgentId,
    customerExternalId: inp.customerExternalId,
    customerEmail: inp.customerEmail,
  };
  const execContext: ExecutionContext = {
    tenantId: inp.tenantId,
    conversationId: inp.conversationId,
    customerExternalId: inp.customerExternalId,
    customerEmail: inp.customerEmail,
    aiAgentId: inp.aiAgentId,
  };

  let wm: WorkingMemory = emptyWorkingMemory(inp.goal);
  let spentUnits = 0;
  let iteration = 0;

  // Anti-stall bookkeeping (deterministic, from real observations - the loop's
  // documented role for `ruledOut`). Judgment stays with the Reasoner: a stalled
  // op is RULED OUT and re-enters reasoning, the loop never decides to give up.
  let lastObsSignature: string | null = null;
  let identicalObsCount = 0;
  let lastFactsSignature: string | null = null;

  // Iteration 0 oracle read.
  let facts = await assembleOracleFacts({
    ctx: capCtx,
    base: { customer: inp.customer, permissions: inp.permissions },
    grants: inp.grants,
    now: new Date().toISOString(),
  });

  let finalDecision: ReasonerDecision = { type: "FINISH", reason: "no_iterations" };
  let finalReplyIntent: ReplyIntent = { purpose: "", keyPoints: [] };
  let finalMemoryUpdate: AgentMemory | null = null;
  let termination: TerminationReason | null = null;

  // Effective policy = platform default tightened by every capability on the menu.
  const menuNamesInit = facts.availableOperations.map((o) => o.name);
  const policy = resolveLoopPolicy(DEFAULT_LOOP_POLICY, engagedLoopPolicies(menuNamesInit));

  // Create the run row up front so every iteration's FK holds (and the run is
  // observable in-flight / survives a mid-loop crash). Finalized at the end.
  await startLoopRun({
    loopId,
    tenantId: inp.tenantId,
    conversationId: inp.conversationId,
    turnId: inp.turnId,
    agentId: inp.aiAgentId,
    goal: inp.goal,
    mode: inp.mode,
    provider: provider.name,
    model: provider.model,
    promptVersion: LOOP_PROMPT_VERSION,
  });

  while (termination === null) {
    iteration++;

    // ── Resource envelope (pre-reason) - iterations / time / budget only ──
    const guard = preReasonTermination(
      { iteration, elapsedMs: Date.now() - startedAt, spentUnits },
      policy,
    );
    if (guard) {
      termination = guard;
      break;
    }

    // ── Ownership probe: a human may have taken the conversation over while
    // earlier iterations ran (a loop can hold the turn for up to 60s). The
    // first iteration is exempt - dispatch already validated ownership.
    // Fail-open: probe errors never kill a healthy turn.
    if (iteration > 1 && inp.ownershipCheck) {
      const stillOwned = await inp.ownershipCheck().catch(() => true);
      if (!stillOwned) {
        termination = "superseded";
        break;
      }
    }

    // ── Reason over current Facts + evolving Working Memory + observations ──
    const context: Context = {
      transcript: inp.transcript,
      mission: inp.mission,
      guidance: inp.guidance,
      operationCatalog: facts.availableOperations.map((o) => ({ name: o.name, meaning: o.meaning })),
      brandVoice: inp.persona,
      workingMemory: wm,
      iteration,
      budgetRemaining: Number.isFinite(policy.maxBudgetUnits) ? policy.maxBudgetUnits - spentUnits : undefined,
    };
    const input: ReasonerInput = { facts, context, memory: inp.memory };

    let decision: ReasonerDecision;
    let replyIntent: ReplyIntent;
    let read: { situation?: string; rationale?: string; missing: string[] } = { missing: [] };
    let iterInTokens: number | null = null;
    let iterOutTokens: number | null = null;
    let latencyMs: number | null = null;

    try {
      const res = await provider.reason(input, {
        context: { tenantId: inp.tenantId, conversationId: inp.conversationId, sessionId: inp.conversationId },
        signal: inp.signal,
      });
      decision = res.output.decision;
      replyIntent = res.output.replyIntent;
      finalMemoryUpdate = res.output.memoryUpdate;
      read = {
        situation: res.output.read.situation,
        rationale: res.output.read.rationale,
        missing: res.output.read.missingInformation.map((m) => m.what).filter(Boolean),
      };
      iterInTokens = res.usage?.inputTokens ?? null;
      iterOutTokens = res.usage?.outputTokens ?? null;
      latencyMs = res.usage?.latencyMs ?? null;
      spentUnits += (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
    } catch (e: any) {
      // The reasoning brain failed (metering block, provider error). Escalate -
      // the loop never fabricates a decision.
      finalDecision = { type: "ESCALATE", reason: `reasoner_error:${String(e?.message || e)}` };
      finalReplyIntent = { purpose: "escalate", keyPoints: [] };
      termination = "escalate";
      await persistLoopIteration({
        loopId, tenantId: inp.tenantId, conversationId: inp.conversationId, iteration,
        goal: inp.goal, oracleFactsSnapshot: facts, reasoningSummary: `reasoner_error:${String(e?.message || e)}`,
        decisionType: "ESCALATE", proposedOperation: null, proposedParams: null,
        runtimeResult: null, observation: null, factsSignature: null,
        progressed: null, inputTokens: null, outputTokens: null, latencyMs: null,
      });
      break;
    }

    finalDecision = decision;
    finalReplyIntent = replyIntent;
    const control = decisionToControl(decision);
    const reasoningSummary = [read.situation, read.rationale].filter(Boolean).join(" - ").slice(0, 500);

    // ── Terminal decision (FINISH / NEED_INPUT / ESCALATE / CONVERSE) ──
    if (control.kind === "terminate") {
      termination = control.reason;
      wm = mergeWorkingMemory(wm, {
        openQuestions: read.missing,
        hypotheses: read.rationale ? [read.rationale] : [],
        iteration: { iteration, decision, observation: undefined, runtimeResult: undefined },
      });
      await persistLoopIteration({
        loopId, tenantId: inp.tenantId, conversationId: inp.conversationId, iteration,
        goal: inp.goal, oracleFactsSnapshot: facts, reasoningSummary,
        decisionType: decision.type, proposedOperation: null, proposedParams: null,
        runtimeResult: null, observation: null, factsSignature: null,
        progressed: null, inputTokens: iterInTokens, outputTokens: iterOutTokens, latencyMs,
      });
      break;
    }

    // ── PROPOSE(operation) → AUTHORIZE (deterministic) → Runtime executes ──
    const { operation, params } = control;

    let runtimeResult: string | null = null;
    let observation: ReturnType<typeof projectObservation> | null = null;
    let ruledOut: { operation: string; why: string }[] = [];
    let established: string[] = [];

    // Guardrails: the single deterministic authorization checkpoint. Covers
    // off-menu/invented ops, missing permission, exhausted budget, suspended
    // billing. A denial is an OBSERVABLE result the Reasoner re-reasons over - it
    // NEVER reaches the Runtime, and the loop NEVER decides to give up on it.
    const verdict = authorizeOperation(operation, facts);
    if (!verdict.allow) {
      runtimeResult = "DENIED";
      observation = { operation, status: "BLOCKED", reason: verdict.reason, invariantSummary: "" };
      ruledOut = [{ operation, why: verdict.reason }];
    } else {
      // Final ownership probe immediately before a real execution: never run a
      // write on a conversation a human just took over (reasoning above may
      // have taken seconds). Fail-open on probe errors.
      if (inp.ownershipCheck && !(await inp.ownershipCheck().catch(() => true))) {
        termination = "superseded";
        await persistLoopIteration({
          loopId, tenantId: inp.tenantId, conversationId: inp.conversationId, iteration,
          goal: inp.goal, oracleFactsSnapshot: facts, reasoningSummary,
          decisionType: decision.type, proposedOperation: operation, proposedParams: params,
          runtimeResult: "SUPERSEDED", observation: "human took over the conversation - loop stood down before executing",
          factsSignature: null, progressed: null,
          inputTokens: iterInTokens, outputTokens: iterOutTokens, latencyMs,
        });
        break;
      }
      // OPERATION_STATUS enforcement (P1-4): the adapter injects the migration
      // ledger, so an operation not yet PROVEN autonomous executes as a dry_run
      // (recommended, never mutating) even in an autonomous turn. Absent the
      // injector, the loop honours `mode` verbatim (hermetic tests execute for
      // real). The observation says why, so the Reasoner routes around it.
      const execMode = inp.operationExecutionMode?.(operation, inp.mode) ?? inp.mode;
      const req: ExecutionRequest = { operation, params, context: execContext, mode: execMode };
      const { result, trace } = await executeOperation(req);
      runtimeResult = result.status;
      observation = projectObservation(operation, result, trace);
      if (execMode === "dry_run" && inp.mode === "autonomous" && observation.outcome) {
        observation.outcome += " (not executed: operation not yet proven autonomous)";
      }

      // Oracle re-reads the world (the write's real effect), not the return value.
      facts = await assembleOracleFacts({
        ctx: capCtx,
        base: { customer: inp.customer, permissions: inp.permissions },
        grants: inp.grants,
        now: new Date().toISOString(),
      });

      if (result.status === "EXECUTED") established = [observationLine(observation)];
      if (result.status === "FAILED" && result.recoverable === false) {
        ruledOut = [{ operation, why: observation.reason ?? "unrecoverable failure" }];
      }
    }

    // ── Anti-stall: identical (operation, outcome) repeating means the world will
    // not yield to this move - rule it out so the Reasoner must ask or pivot.
    // Deterministic maintenance of `ruledOut` from observations (its charter);
    // the DECISION about what to do next remains the Reasoner's.
    const obsSignature = observation
      ? `${operation}|${observation.status}|${observation.reason ?? ""}`
      : null;
    if (obsSignature && obsSignature === lastObsSignature) {
      identicalObsCount++;
      if (identicalObsCount >= 2 && observation!.status !== "EXECUTED" && ruledOut.length === 0) {
        ruledOut = [{
          operation,
          why: `proposed ${identicalObsCount}× with an identical outcome (${observation!.status}${observation!.reason ? `: ${observation!.reason}` : ""}) - do NOT propose it again; ask the customer for the missing input or choose a different move`,
        }];
      }
    } else {
      identicalObsCount = obsSignature ? 1 : 0;
      lastObsSignature = obsSignature;
    }

    // Progress observability (persisted): did this iteration change the world or
    // surface anything new? Wires the audit's dead columns.
    const factsSignature = signatureOfFacts(facts);
    const progressed = factsSignature !== lastFactsSignature || identicalObsCount <= 1;
    lastFactsSignature = factsSignature;

    const iterTrace: IterationTrace = {
      iteration,
      decision,
      proposedOperation: operation,
      observation: observation ? observationLine(observation) : undefined,
      runtimeResult: runtimeResult ?? undefined,
    };
    wm = mergeWorkingMemory(wm, {
      establishedFacts: established,
      openQuestions: read.missing,
      hypotheses: read.rationale ? [read.rationale] : [],
      ruledOut,
      iteration: iterTrace,
    });

    await persistLoopIteration({
      loopId, tenantId: inp.tenantId, conversationId: inp.conversationId, iteration,
      goal: inp.goal, oracleFactsSnapshot: facts, reasoningSummary,
      decisionType: decision.type, proposedOperation: operation, proposedParams: params,
      runtimeResult, observation, factsSignature,
      progressed, inputTokens: iterInTokens, outputTokens: iterOutTokens, latencyMs,
    });

    // ── Runtime-forced termination (approval / blocked / unrecoverable failure) ──
    if (observation) {
      const forced = runtimeResultToTermination(observation.status, observation.recoverable);
      if (forced) {
        termination = forced;
        break;
      }
    }
    // else: observation re-enters - loop again.
  }

  const reason = termination ?? "max_iterations";
  // A superseded loop stood down because a human owns the conversation now -
  // it must produce NO customer-facing reply (the human is talking).
  const reply = reason === "superseded"
    ? null
    : await writeReply(finalReplyIntent, {
        language: inp.language,
        termination: reason,
        tenantId: inp.tenantId,
        conversationId: inp.conversationId,
        brandVoice: inp.persona ? { tone: inp.persona.voice, persona: inp.persona.displayName } : undefined,
      });
  const wallMs = Date.now() - startedAt;

  await finalizeLoopRun({
    loopId,
    tenantId: inp.tenantId,
    conversationId: inp.conversationId,
    turnId: inp.turnId,
    agentId: inp.aiAgentId,
    goal: inp.goal,
    terminationReason: reason,
    iterationCount: iteration,
    spentUnits,
    wallMs,
    mode: inp.mode,
    finalDecision,
    finalReplyIntent,
    reply,
    provider: provider.name,
    model: provider.model,
    promptVersion: LOOP_PROMPT_VERSION,
  });

  return {
    loopId,
    terminationReason: reason,
    iterations: iteration,
    reply,
    finalDecision,
    goal: inp.goal,
    spentUnits,
    wallMs,
    workingMemory: wm,
    memoryUpdate: finalMemoryUpdate,
  };
}
