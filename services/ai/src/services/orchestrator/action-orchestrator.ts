import {
  prisma,
  publishEvent,
  evaluatePolicies,
  createApprovalRequest,
  getRedis,
  type PolicyResult,
} from "@chatcenter/shared";
import { CircuitBreakers, withRetry, pushToDlq } from "./runner";
import type {
  ExecutionResult,
  ProposedAction,
  RuntimeMode,
} from "./types";
import {
  classifySideEffect,
  semanticKey,
  extractExternalRef,
  type SemanticKeyCtx,
  type SideEffectInfo,
} from "../side-effect-classifier";
import type { OutcomeStatus, TurnOutcomeLedger } from "../turn-outcome-ledger";

/**
 * Per-call options for the Turn Outcome Ledger (within-turn dedup + the
 * single source of truth for side effects). Optional → non-bot callers
 * (voice, live-analysis) are unaffected when omitted.
 */
export interface SubmitLedgerOpts {
  ledger?: TurnOutcomeLedger;
  ctx?: SemanticKeyCtx;
  /**
   * Cross-turn (redelivery) idempotency. When true AND the action carries a
   * conversationId, a committable side effect is keyed by its semantic key in
   * Redis: a redelivered inbound message that re-runs the SAME semantic action
   * reuses the prior committed result instead of creating a duplicate external
   * object (a second calendar event / lead). Fail-soft: any Redis error degrades
   * to a normal execution. Off by default → non-bot callers are unaffected.
   */
  idempotency?: boolean;
}

/** Redelivery window for cross-turn idempotency. WhatsApp/webhook retries land
 * within seconds–minutes; 2h is a safe upper bound that still avoids blocking a
 * genuinely repeated action far in the future. */
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 2;

/**
 * The Action Orchestrator - Layer 3 of the architecture.
 *
 * SINGLE entry point for tool execution across Chat, Live, and Post-Call.
 * Direct calls to the underlying tool registry from outside this package
 * are forbidden (anti-duplication rule #3).
 *
 * Policy: tenant configuration is the source of truth. Every submit() resolves
 * the HITL decision via the shared `evaluatePolicies()` gate, which composes
 * `CatalogTool.hitlPolicy` (catalog floor) with
 * `TenantTool.configOverrides.hitlPolicy` (tenant override, authoritative).
 * No tool slugs are hardcoded here.
 *
 * Responsibilities:
 *   - Resolve the per-tenant HITL gate decision for every proposal
 *   - Persist a ToolExecutionRequest row for the full lifecycle
 *   - For auto-execute: run with retry + circuit breaker; on permanent
 *     failure push to DLQ
 *   - For propose-and-await-approval: emit `tool.execution.proposed`,
 *     persist a "proposed" row, return executionId
 *   - For deny: emit `tool.execution.denied`
 */
export class ActionOrchestrator {
  private readonly breakers: CircuitBreakers;

  constructor(opts?: { breakers?: CircuitBreakers }) {
    this.breakers = opts?.breakers ?? new CircuitBreakers();
  }

  /**
   * Submit an action. Returns when the lifecycle terminal step lands:
   *   - auto-execute  → completed | failed | denied (by breaker)
   *   - propose       → proposed
   *   - deny          → denied
   *
   * The `executor` thunk is invoked only when the tenant HITL config
   * resolves to ALLOW. REQUIRE_APPROVAL parks the row at status='proposed'
   * for the agent UI to approve and re-run.
   */
  async submit(
    action: ProposedAction,
    executor: () => Promise<unknown>,
    opts?: SubmitLedgerOpts,
  ): Promise<ExecutionResult> {
    // ── Turn Outcome Ledger: within-turn semantic dedup ──────────────
    // If this exact semantic side effect already SUCCEEDED this turn (committed
    // OR succeeded_unverified), short-circuit and return the stored result.
    // Prevents duplicate external objects and self-collisions (e.g. a second
    // schedule_meeting seeing the first booking as agent_busy). Generic: no
    // per-tool logic — classification is derived from the existing taxonomy.
    const ledger = opts?.ledger;
    let info: SideEffectInfo | undefined;
    let key: string | undefined;
    // Classify whenever we have EITHER a ledger (within-turn dedup) or
    // idempotency (cross-turn dedup) so a redelivery is caught even on a fresh
    // turn whose in-memory ledger is empty.
    if (ledger || opts?.idempotency) {
      info = classifySideEffect(action.tool);
      if (info.sideEffect) {
        key = semanticKey(info, action.args as Record<string, any>, opts?.ctx);
        // 1) Within-turn: this exact semantic action already succeeded this turn.
        if (ledger?.hasSucceeded(key)) {
          const prior = ledger.get(key)!;
          console.log(
            `[orchestrator] ledger dedup hit tool=${action.tool} key=${key} ` +
              `→ reusing ${prior.status} result (no re-execute)`,
          );
          return prior.result as ExecutionResult;
        }
        // 2) Cross-turn (redelivery): a prior turn already committed this exact
        // semantic action. Seed the in-memory ledger so within-turn consistency
        // + the committed-summary injection treat it as committed, then return.
        if (opts?.idempotency) {
          const cached = await this.idempotencyLookup(action, key);
          if (cached) {
            console.log(
              `[orchestrator] idempotency hit tool=${action.tool} key=${key} ` +
                `→ reusing committed result from a prior turn (no re-execute)`,
            );
            if (ledger) this.recordToLedger(ledger, info, key, action.tool, cached);
            return cached;
          }
        }
      }
    }

    const recordIfLedger = (r: ExecutionResult): ExecutionResult => {
      if (info?.sideEffect && key) {
        if (ledger) this.recordToLedger(ledger, info, key, action.tool, r);
        // Persist for cross-turn redelivery defense (only commits are stored).
        if (opts?.idempotency) void this.persistIdempotency(action, info, key, r);
      }
      return r;
    };

    let gate: PolicyResult;
    try {
      gate = await evaluatePolicies({
        tenantId: action.tenantId,
        toolName: action.tool,
        args: action.args,
      });
    } catch (err: any) {
      // Gate failure must not silently auto-execute. Treat as deny so the
      // human approval path remains the safe fallback.
      const reason = `policy-gate-error: ${err?.message ?? String(err)}`;
      console.warn("[orchestrator] gate evaluation failed:", reason);
      return recordIfLedger(await this.recordDeny(action, reason, "policy"));
    }

    if (gate.decision === "DENY") {
      return recordIfLedger(await this.recordDeny(action, gate.reason, "policy"));
    }
    if (gate.decision === "REQUIRE_APPROVAL") {
      return recordIfLedger(await this.recordPropose(action, gate));
    }
    // ALLOW → auto-execute
    return recordIfLedger(await this.runAutoExecute(action, executor));
  }

  /**
   * Derive the ledger status + external ref from a completed submit() result.
   * Shared by the in-memory ledger record AND the cross-turn idempotency store
   * so both classify a result identically (single derivation path).
   */
  private deriveOutcome(
    info: SideEffectInfo,
    exec: ExecutionResult,
  ): { status: OutcomeStatus; ref: ReturnType<typeof extractExternalRef> } {
    let parsed: any = {};
    const inner: any = exec.result;
    if (exec.status === "completed" && inner && typeof inner === "object") {
      if (typeof inner.content === "string") {
        try { parsed = JSON.parse(inner.content); } catch { parsed = {}; }
      } else {
        parsed = inner;
      }
    }
    const ref = extractExternalRef(info.kind, parsed);
    let status: OutcomeStatus;
    if (exec.status === "proposed") status = "pending_approval";
    else if (exec.status === "denied") status = "denied";
    else if (exec.status === "failed") status = "failed";
    else status = parsed?.ok === true ? (ref ? "committed" : "succeeded_unverified") : "failed";
    return { status, ref };
  }

  /**
   * Record a completed submit() into the ledger. A success with NO real external
   * id is recorded as `succeeded_unverified` and logged as a LEDGER_GAP (the
   * handler should return an id).
   */
  private recordToLedger(
    ledger: TurnOutcomeLedger,
    info: SideEffectInfo,
    key: string,
    tool: string,
    exec: ExecutionResult,
  ): void {
    const { status, ref } = this.deriveOutcome(info, exec);

    if (status === "succeeded_unverified") {
      console.warn(
        `[orchestrator] LEDGER_GAP: ${tool} (kind=${info.kind}) returned ok:true with no ` +
          `externalRef — recorded as succeeded_unverified (deduped, but not confidently ` +
          `claimable). Add a real id (eventId/leadId/messageId/…) to the handler result.`,
      );
    }
    ledger.record({
      semanticKey: key,
      tool,
      kind: info.kind,
      visibility: info.visibility,
      status,
      externalRef: ref,
      result: exec,
    });
  }

  // ── Cross-turn idempotency (redelivery defense) ────────────────────
  // Keyed by tenant + conversation + semantic key so a redelivered inbound
  // message that re-runs the SAME semantic action reuses the prior committed
  // result. ALL Redis access is fail-soft: an error degrades to normal
  // execution (the within-turn ledger still prevents same-turn duplicates).

  private idemKey(action: ProposedAction, semanticKeyStr: string): string | null {
    if (!action.conversationId) return null;
    return `idem:tool:${action.tenantId}:${action.conversationId}:${semanticKeyStr}`;
  }

  private async idempotencyLookup(
    action: ProposedAction,
    semanticKeyStr: string,
  ): Promise<ExecutionResult | null> {
    const k = this.idemKey(action, semanticKeyStr);
    if (!k) return null;
    try {
      const raw = await getRedis().get(k);
      if (!raw) return null;
      return JSON.parse(raw) as ExecutionResult;
    } catch (err: any) {
      console.warn("[orchestrator] idempotency lookup failed (degrading to execute):", err?.message);
      return null;
    }
  }

  /**
   * Persist a COMMITTED result for cross-turn dedup. Only real commits (ok:true
   * WITH an external ref) are stored — never failures, denials, or unverified
   * successes — so a redelivery can never reuse a non-result and a failed first
   * attempt does not block a later genuine retry. SET NX → the first committer
   * wins; concurrent redeliveries can't clobber each other.
   */
  private async persistIdempotency(
    action: ProposedAction,
    info: SideEffectInfo,
    semanticKeyStr: string,
    exec: ExecutionResult,
  ): Promise<void> {
    const k = this.idemKey(action, semanticKeyStr);
    if (!k) return;
    const { status } = this.deriveOutcome(info, exec);
    if (status !== "committed") return;
    try {
      await getRedis().set(k, JSON.stringify(exec), "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
    } catch (err: any) {
      console.warn("[orchestrator] idempotency persist failed (non-fatal):", err?.message);
    }
  }

  /**
   * Approval surface entry. Marks the row as approved and emits the
   * lifecycle event. Phase 4 does NOT re-execute on approve - the agent
   * UI is responsible for re-issuing the action with full context if
   * desired. A polish pass can promote re-execution into the orchestrator.
   */
  async approve(
    executionId: string,
    approvedBy: string,
  ): Promise<ExecutionResult> {
    try {
      await (prisma as any).toolExecutionRequest.update({
        where: { id: executionId },
        data: {
          status: "approved",
          decidedAt: new Date(),
          actor: { agentId: approvedBy },
        },
      });
    } catch (err: any) {
      console.warn("[orchestrator] approve persist failed:", err?.message);
    }
    await this.emit("tool.execution.approved", executionId, { approvedBy });
    return { status: "approved", attempts: 0 };
  }

  async deny(
    executionId: string,
    deniedBy: string,
    reason: string,
  ): Promise<void> {
    try {
      await (prisma as any).toolExecutionRequest.update({
        where: { id: executionId },
        data: {
          status: "denied",
          decidedAt: new Date(),
          error: reason,
          actor: { agentId: deniedBy },
        },
      });
    } catch (err: any) {
      console.warn("[orchestrator] deny persist failed:", err?.message);
    }
    await this.emit("tool.execution.denied", executionId, { deniedBy, reason });
  }

  // ── Internal pipeline steps ────────────────────────────────

  private async recordPropose(
    action: ProposedAction,
    gate: PolicyResult,
  ): Promise<ExecutionResult> {
    await this.persistInitialRow(action, "proposed", { reason: gate.reason });
    await this.emit("tool.execution.proposed", action.id, {
      tenantId: action.tenantId,
      conversationId: action.conversationId,
      tool: action.tool,
      args: action.args,
      rationale: action.rationale,
      urgency: action.urgency,
      proposedBy: action.proposedBy,
    });

    // Surface to the agent UI's Approvals page. Without this row, REQUIRE_APPROVAL
    // tools would persist a TER record but be invisible to the human approver.
    try {
      await createApprovalRequest({
        tenantId: action.tenantId,
        conversationId: action.conversationId || undefined,
        tool: action.tool,
        params: action.args,
        summary: action.rationale || `Approve ${action.tool}`,
        reason: gate.reason,
        riskLevel: action.urgency === "high" ? "high" : action.urgency === "medium" ? "medium" : "low",
        requestedBy: `${action.proposedBy.system}:${action.proposedBy.mode}`,
        gate: { decision: gate.decision, reason: gate.reason, approvalConfig: gate.approvalConfig },
      });
    } catch (err: any) {
      console.warn("[orchestrator] createApprovalRequest failed:", err?.message);
    }

    return { status: "proposed", attempts: 0 };
  }

  private async recordDeny(
    action: ProposedAction,
    reason: string,
    deniedBy: string,
  ): Promise<ExecutionResult> {
    await this.persistInitialRow(action, "denied", { reason });
    await this.emit("tool.execution.denied", action.id, {
      tenantId: action.tenantId,
      conversationId: action.conversationId,
      tool: action.tool,
      reason,
      deniedBy,
    });
    return { status: "denied", attempts: 0, error: reason };
  }

  private async runAutoExecute(
    action: ProposedAction,
    executor: () => Promise<unknown>,
  ): Promise<ExecutionResult> {
    const breakerKey = `${action.tenantId}:${action.tool}`;
    if (this.breakers.isOpen(breakerKey)) {
      return this.recordDeny(action, "circuit_open", "breaker");
    }

    await this.persistInitialRow(action, "running", {});
    await this.emit("tool.execution.started", action.id, {
      tenantId: action.tenantId,
      conversationId: action.conversationId,
      tool: action.tool,
    });

    const startedAt = Date.now();
    const outcome = await withRetry(executor);

    const durationMs = Date.now() - startedAt;
    if (outcome.ok) {
      this.breakers.recordSuccess(breakerKey);
      await this.finalize(action.id, "completed", {
        result: outcome.result,
        attempts: outcome.attempts,
        durationMs,
      });
      await this.emit("tool.execution.completed", action.id, {
        tenantId: action.tenantId,
        conversationId: action.conversationId,
        result: outcome.result,
        durationMs,
      });
      return {
        status: "completed",
        result: outcome.result,
        attempts: outcome.attempts,
        durationMs,
      };
    }

    this.breakers.recordFailure(breakerKey);
    const errMsg =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    await this.finalize(action.id, "failed", {
      error: errMsg,
      attempts: outcome.attempts,
      durationMs,
    });
    await pushToDlq({
      executionId: action.id,
      tenantId: action.tenantId,
      conversationId: action.conversationId,
      tool: action.tool,
      args: action.args,
      error: errMsg,
      attempts: outcome.attempts,
      failedAt: new Date().toISOString(),
    });
    await this.emit("tool.execution.failed", action.id, {
      tenantId: action.tenantId,
      conversationId: action.conversationId,
      error: errMsg,
      attempts: outcome.attempts,
      durationMs,
    });
    return {
      status: "failed",
      error: errMsg,
      attempts: outcome.attempts,
      durationMs,
    };
  }

  private async persistInitialRow(
    action: ProposedAction,
    status: "proposed" | "running" | "denied",
    extra: { reason?: string },
  ): Promise<void> {
    try {
      await (prisma as any).toolExecutionRequest.upsert({
        where: { id: action.id },
        create: {
          id: action.id,
          conversationId: action.conversationId,
          tenantId: action.tenantId,
          proposedBy: action.proposedBy,
          actor: action.actor,
          tool: action.tool,
          args: action.args,
          rationale: action.rationale,
          status,
          attempts: status === "running" ? 1 : 0,
          startedAt: status === "running" ? new Date() : undefined,
          error: extra.reason && status === "denied" ? extra.reason : undefined,
        },
        update: {
          status,
          startedAt: status === "running" ? new Date() : undefined,
          error: extra.reason && status === "denied" ? extra.reason : undefined,
        },
      });
    } catch (err: any) {
      console.warn(
        "[orchestrator] persistInitialRow failed:",
        err?.message,
      );
    }
  }

  private async finalize(
    executionId: string,
    status: "completed" | "failed",
    extra: { result?: unknown; error?: string; attempts: number; durationMs: number },
  ): Promise<void> {
    try {
      await (prisma as any).toolExecutionRequest.update({
        where: { id: executionId },
        data: {
          status,
          completedAt: new Date(),
          attempts: extra.attempts,
          result: extra.result === undefined ? undefined : (extra.result as any),
          error: extra.error,
        },
      });
    } catch (err: any) {
      console.warn("[orchestrator] finalize failed:", err?.message);
    }
  }

  private async emit(
    event: string,
    executionId: string,
    payload: Record<string, unknown> & { tenantId?: string },
  ): Promise<void> {
    try {
      await publishEvent({
        event,
        tenantId: String(payload.tenantId ?? ""),
        data: { executionId, ...payload, ts: new Date().toISOString() },
      });
    } catch (err: any) {
      console.warn(`[orchestrator] emit ${event} failed:`, err?.message);
    }
  }
}

/**
 * Module-level singleton for callers that don't need to inject a custom
 * policy or breaker. Tests can `new ActionOrchestrator(...)` directly.
 */
let _singleton: ActionOrchestrator | null = null;
export function getActionOrchestrator(): ActionOrchestrator {
  if (!_singleton) _singleton = new ActionOrchestrator();
  return _singleton;
}

/** Used by `getRuntimeMode` callers; documents valid values without a circular import. */
export function assertRuntimeMode(m: string): RuntimeMode {
  if (m === "chat" || m === "live" || m === "post-call") return m;
  throw new Error(`invalid runtime mode: ${m}`);
}
