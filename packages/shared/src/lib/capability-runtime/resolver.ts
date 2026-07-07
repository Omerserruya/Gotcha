/**
 * Capability Runtime — the Resolver (pure orchestration).
 *
 * Given an OperationContract + an ExecutionRequest + injected RuntimeBindings
 * (verifiers, satisfiers, strategy, approval), it GUARANTEES the contract's
 * correctness envelope and returns a semantic ExecutionResult. It is fully pure:
 * no Prisma, no REST, no provider knowledge — all of that is injected. This is
 * the layer that "guarantees, never decides": when it cannot proceed without
 * customer meaning or a value judgment, it returns NEEDS_INPUT / FAILED to the
 * caller (the planner) rather than deciding.
 *
 * Pipeline:
 *   1. PRE invariants  — probe-first (skips fresh reads); a runtime_read dep is
 *      auto-satisfied by running its satisfier OPERATION; still-unsatisfied ->
 *      NEEDS_INPUT / FAILED / BLOCKED (MUST) or proceed (SHOULD).
 *   2. Mode eligibility — advisory mode short-circuits a WRITE to RECOMMENDED.
 *   3. Approval gate    — HITL -> AWAITING_APPROVAL.
 *   4. Execute strategy — provider / workflow / MCP / worker (opaque).
 *   5. POST invariants + success — the CORRECTNESS ENVELOPE, re-verified against
 *      world-state regardless of the path the optimizer took. This is why
 *      aggressive optimization (skipped reads, batching, provider swaps) is safe.
 *
 * Instrumentation (Constraint 2): the resolver builds an ExecutionTrace as it
 * runs and emits it via `bind.emitTrace` on every terminal return — so WHY an
 * operation succeeded or failed is observable without provider logs.
 */

import type {
  OperationContract,
  ExecutionRequest,
  ExecutionResult,
  ExecutionTrace,
  Invariant,
  InvariantOutcome,
} from "./contract";

/** A world-state snapshot the verifiers/strategy read. Opaque to the resolver. */
export type WorldState = Record<string, unknown>;

/** Predicate: does this invariant/success condition currently hold? */
export type InvariantVerifier = (
  req: ExecutionRequest,
  state: WorldState,
) => boolean | Promise<boolean>;

/** Result of executing a strategy or running a satisfier operation. */
export type StrategyResult =
  | { ok: true; outcome: string; data?: Record<string, unknown> }
  | { ok: false; reason: string; recoverable?: boolean; data?: Record<string, unknown> };

/** Everything the pure resolver needs, injected by the runtime (services/ai). */
export interface RuntimeBindings {
  /** Verifier per predicate id (invariant id or success id). */
  verifiers: Record<string, InvariantVerifier>;
  /** Run a READ operation to satisfy a dependency; its data merges into state. */
  runSatisfier: (
    operationId: string,
    req: ExecutionRequest,
    state: WorldState,
  ) => Promise<StrategyResult>;
  /** Execute the terminal strategy for this contract. */
  executeStrategy: (
    contract: OperationContract,
    req: ExecutionRequest,
    state: WorldState,
  ) => Promise<StrategyResult>;
  /** Optional HITL gate. `opts.probe` = evaluate policy only, create nothing. */
  approvalGate?: (
    contract: OperationContract,
    req: ExecutionRequest,
    opts?: { probe?: boolean },
  ) => Promise<{ required: true; ref: string } | { required: false }>;
  /** Optional world-state loader (the business-state oracle entrypoint). */
  loadState?: (req: ExecutionRequest) => Promise<WorldState>;
  /** Strategy label for the trace, e.g. "calendar.google". */
  strategyId?: string;
  /** Observability sink: receives the full ExecutionTrace on every terminal return. */
  emitTrace?: (trace: ExecutionTrace) => void;
}

async function verify(
  inv: Invariant,
  req: ExecutionRequest,
  state: WorldState,
  bind: RuntimeBindings,
): Promise<{ holds: boolean; attested?: boolean }> {
  const v = bind.verifiers[inv.id];
  // A PROVIDER_ATTESTED invariant with no runtime verifier is trusted to the
  // strategy (the POST/success check is the backstop). A RUNTIME_VERIFIED
  // invariant with no verifier is a CONFIG ERROR — fail loud, never silently pass.
  if (!v) {
    if (inv.enforcement === "PROVIDER_ATTESTED") return { holds: true, attested: true };
    throw new Error(
      `capability-runtime: missing RUNTIME_VERIFIED verifier for invariant "${inv.id}"`,
    );
  }
  return { holds: await v(req, state) };
}

export async function resolveExecution(
  contract: OperationContract,
  req: ExecutionRequest,
  bind: RuntimeBindings,
): Promise<ExecutionResult> {
  let state: WorldState = bind.loadState ? await bind.loadState(req) : {};

  const trace: ExecutionTrace = {
    operation: contract.id,
    capability: contract.capability,
    mode: req.mode,
    strategy: bind.strategyId,
    invariants: [],
    optimizations: [],
    executed: false,
    result: "BLOCKED",
  };
  const record = (inv: Invariant, outcome: InvariantOutcome) =>
    trace.invariants.push({
      id: inv.id,
      checkpoint: inv.checkpoint,
      strength: inv.strength,
      enforcement: inv.enforcement,
      outcome,
      satisfierOperation: inv.satisfierOperation,
    });
  const done = (result: ExecutionResult): ExecutionResult => {
    trace.result = result.status;
    if (result.status === "EXECUTED") trace.outcome = result.outcome;
    else if (result.status === "NEEDS_INPUT" || result.status === "BLOCKED" || result.status === "FAILED") {
      trace.reason = (result as any).reason ?? (result as any).field;
    }
    bind.emitTrace?.(trace);
    return result;
  };

  // ── 1. PRE invariants (probe-first; auto-satisfy reads) ──
  for (const inv of contract.invariants.filter((i) => i.checkpoint === "PRE")) {
    const first = await verify(inv, req, state, bind);
    if (first.holds) {
      record(inv, first.attested ? "trusted_attested" : "held");
      // Probe-first optimization: a fresh dependency with a satisfier is NOT re-read.
      if (inv.satisfierOperation && !first.attested) {
        trace.optimizations.push(
          `probe-first: "${inv.id}" already satisfied → skipped read ${inv.satisfierOperation}`,
        );
      }
      continue;
    }

    // Try to satisfy a runtime_read dependency by running its satisfier operation.
    if (inv.satisfierOperation) {
      const sat = await bind.runSatisfier(inv.satisfierOperation, req, state);
      if (sat.ok) {
        state = { ...state, ...(sat.data ?? {}) };
        if ((await verify(inv, req, state, bind)).holds) {
          record(inv, "satisfied_by_read");
          continue;
        }
      }
    }

    // Still unsatisfied — return control rather than deciding.
    if (inv.onUnsatisfied?.kind === "NEEDS_INPUT") {
      record(inv, "unsatisfied");
      return done({ status: "NEEDS_INPUT", field: inv.onUnsatisfied.field, reason: inv.statement });
    }
    if (inv.onUnsatisfied?.kind === "FAILED") {
      record(inv, "unsatisfied");
      return done({ status: "FAILED", reason: inv.onUnsatisfied.reason, recoverable: true });
    }
    if (inv.strength === "MUST") {
      record(inv, "unsatisfied");
      return done({ status: "BLOCKED", reason: `unsatisfied_invariant:${inv.id}` });
    }
    // SHOULD with no resolution: proceed (best-effort); POST/success is the backstop.
    record(inv, "skipped_should");
  }

  // ── 2. Mode eligibility — advisory/dry_run recommend WRITES, never execute.
  // advisory (copilot): short-circuit before the gate — a human is already in
  // the loop. dry_run (shadow/evaluation): PROBE the gate first (no request
  // created) so the trace proves whether the write WOULD have required
  // approval — shadow evidence must cover the HITL surface, not just writes.
  if (contract.effect === "write" && req.mode === "advisory") {
    return done({ status: "RECOMMENDED", proposal: { operation: contract.id, params: req.params } });
  }
  if (contract.effect === "write" && req.mode === "dry_run") {
    if (contract.approval !== "none" && bind.approvalGate) {
      try {
        const probe = await bind.approvalGate(contract, req, { probe: true });
        trace.approvalProbe = { wouldRequire: probe.required };
      } catch (err: any) {
        trace.approvalProbe = { wouldRequire: true, reason: String(err?.message || err) };
      }
    }
    return done({ status: "RECOMMENDED", proposal: { operation: contract.id, params: req.params } });
  }

  // ── 3. Approval (HITL) ──
  if (contract.effect === "write" && contract.approval !== "none" && bind.approvalGate) {
    const a = await bind.approvalGate(contract, req);
    if (a.required) return done({ status: "AWAITING_APPROVAL", ref: a.ref });
  }

  // ── 4. Execute strategy ──
  const exec = await bind.executeStrategy(contract, req, state);
  trace.executed = true;
  if (!exec.ok) {
    return done({ status: "FAILED", reason: exec.reason, data: exec.data, recoverable: exec.recoverable ?? true });
  }
  state = { ...state, ...(exec.data ?? {}) };

  // ── 5. POST invariants + success (the correctness envelope) ──
  for (const inv of contract.invariants.filter((i) => i.checkpoint === "POST")) {
    const { holds } = await verify(inv, req, state, bind);
    if (!holds && inv.strength === "MUST") {
      record(inv, "violated");
      return done({
        status: "FAILED",
        reason: `post_invariant_violated:${inv.id}`,
        data: exec.data,
        recoverable: false,
      });
    }
    record(inv, holds ? "held" : "skipped_should");
  }

  const successVerifier = bind.verifiers[contract.success.id];
  if (!successVerifier) throw new Error(`capability-runtime: missing success verifier "${contract.success.id}"`);
  trace.successVerified = await successVerifier(req, state);
  if (!trace.successVerified) {
    return done({
      status: "FAILED",
      reason: `success_not_verified:${contract.success.id}`,
      data: exec.data,
      recoverable: true,
    });
  }

  return done({ status: "EXECUTED", outcome: exec.outcome, data: exec.data });
}
