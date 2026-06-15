import {
  prisma,
  publishEvent,
  evaluatePolicies,
  createApprovalRequest,
  type PolicyResult,
} from "@chatcenter/shared";
import { CircuitBreakers, withRetry, pushToDlq } from "./runner";
import type {
  ExecutionResult,
  ProposedAction,
  RuntimeMode,
} from "./types";

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
  ): Promise<ExecutionResult> {
    let gate;
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
      return this.recordDeny(action, reason, "policy");
    }

    if (gate.decision === "DENY") {
      return this.recordDeny(action, gate.reason, "policy");
    }
    if (gate.decision === "REQUIRE_APPROVAL") {
      return this.recordPropose(action, gate);
    }
    // ALLOW → auto-execute
    return this.runAutoExecute(action, executor);
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
