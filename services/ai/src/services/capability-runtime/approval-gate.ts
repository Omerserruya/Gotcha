/**
 * Kernel approval gate — wires the Capability Runtime's `approvalGate` slot to the
 * EXISTING production HITL stack. No new policy machinery: the decision comes from
 * the shared `evaluatePolicies` (CatalogTool/SYSTEM floor + authoritative tenant
 * overrides), and an approval surfaces through the shared `createApprovalRequest`
 * (the same Approvals inbox card the legacy brain uses). Approval RESUME also rides
 * the existing flow untouched: the human approves in the inbox → conversation
 * un-pauses → `dispatchApprovedAction` executes the approved tool.
 *
 * The op→policy-tool mapping lives in each capability's runtime (the operation→
 * concrete translation layer), never here and never above the Runtime.
 *
 * Semantics:
 *   ALLOW            → { required: false } (resolver proceeds to execute)
 *   REQUIRE_APPROVAL → reuse a still-PENDING request for the same tool+conversation
 *                      (idempotent across turns), else create one → { required, ref }
 *   DENY             → throw (the runtime converts to an observable FAILED — the
 *                      operation must never run, and never silently)
 *
 * Only consulted for WRITE contracts with `approval !== "none"`, and only in
 * autonomous mode (advisory/shadow short-circuits to RECOMMENDED before this).
 */

import {
  evaluatePolicies,
  createApprovalRequest,
  findPendingByConversation,
  prisma,
  type OperationContract,
  type ExecutionRequest,
} from "@chatcenter/shared";

export interface KernelApprovalMapping {
  /** The legacy tool name whose HITL policy governs this operation. */
  policyTool: string;
  /** Concrete args for `on_condition` evaluation (e.g. duration_minutes). */
  args: Record<string, unknown>;
}

export async function kernelApprovalGate(
  contract: OperationContract,
  req: ExecutionRequest,
  map: KernelApprovalMapping,
  opts?: { probe?: boolean },
): Promise<{ required: true; ref: string } | { required: false }> {
  const tenantId = req.context.tenantId;
  const conversationId = req.context.conversationId;
  const aiAgentId = req.context.aiAgentId as string | undefined;

  // Approval-resume (P1-3/B6): the approved-action dispatcher re-enters the
  // Runtime with the approved request's id. A matching APPROVED row for THIS
  // tool on THIS conversation satisfies the gate — the human already decided.
  // Everything else about the execution (invariants, verification) still runs.
  if (req.approval?.approvedRef) {
    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.approval.approvedRef, tenantId },
      select: { status: true, tool: true, conversationId: true },
    });
    if (row?.status === "APPROVED" && row.tool === map.policyTool && row.conversationId === conversationId) {
      return { required: false };
    }
    // A stale/mismatched ref must NOT silently re-ask or auto-allow — fail loud.
    throw new Error(`approval_resume_ref_invalid:${req.approval.approvedRef}`);
  }

  // Production policy decision (catalog floor + tenant override). A throw here
  // propagates: the runtime surfaces FAILED — never silently auto-execute.
  const gate = await evaluatePolicies({
    tenantId,
    toolName: map.policyTool,
    aiAgentId,
    args: map.args,
  });

  if (gate.decision === "ALLOW") return { required: false };
  if (gate.decision === "DENY") {
    // The tenant disabled this tool. Observable failure; the Reasoner re-reasons.
    throw new Error(`policy_denied:${gate.reason}`);
  }

  // PROBE (dry_run): report the policy decision without creating a request —
  // shadow evidence covers the HITL surface with zero inbox side effects.
  if (opts?.probe) return { required: true, ref: "dry_run_probe" };

  // REQUIRE_APPROVAL — idempotent across turns: if a request for this tool is
  // already pending on this conversation, point at it instead of duplicating.
  const pending = await findPendingByConversation(tenantId, conversationId).catch(() => [] as any[]);
  const existing = (pending as any[]).find((p) => p?.tool === map.policyTool);
  if (existing) return { required: true, ref: existing.id };

  const created = await createApprovalRequest({
    tenantId,
    conversationId,
    tool: map.policyTool,
    params: map.args,
    summary: `Approve: ${contract.meaning}`,
    reason: gate.reason,
    riskLevel: "medium",
    requestedBy: `agent-loop:${aiAgentId ?? "unknown"}`,
    gate: { decision: gate.decision, reason: gate.reason, approvalConfig: gate.approvalConfig } as any,
    // Kernel resume envelope: approval-resume re-enters the Runtime with the
    // ORIGINAL operation-level request (not the legacy tool executor).
    resumeEnvelope: {
      kind: "kernel_operation",
      operation: req.operation,
      params: req.params,
      context: req.context as unknown as Record<string, unknown>,
      mode: req.mode,
    },
  });
  return { required: true, ref: created.id };
}
