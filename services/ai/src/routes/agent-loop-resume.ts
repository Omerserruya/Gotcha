/**
 * Agent-loop approval resume (P1-3 / B6) — internal-only.
 *
 * When a human approves a KERNEL-originated request (ApprovalRequest rows
 * carrying `resumeEnvelope.kind === "kernel_operation"`), the conversation
 * service dispatches here instead of the legacy tool executor. The stored
 * ExecutionRequest re-enters the Capability Runtime — invariants, verification
 * and observability all apply to the HITL write — with `approval.approvedRef`
 * set so the gate recognises the human's decision instead of re-asking.
 *
 * Protected by the same `X-Internal-Key` shared secret as /api/ai-bot.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "@chatcenter/shared";
import { ensureCapabilitiesRegistered, executeOperation } from "../services/capability-plane";

const router = Router();

function internalOnly(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-internal-key"];
  if (!key || key !== (process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

router.post("/execute-approved", internalOnly, async (req: Request, res: Response) => {
  try {
    const { tenantId, approvalId } = req.body ?? {};
    if (!tenantId || !approvalId) {
      res.status(400).json({ error: "tenantId and approvalId are required" });
      return;
    }

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: approvalId, tenantId },
      select: { status: true, conversationId: true, resumeEnvelope: true, modifiedParams: true },
    });
    if (!row) { res.status(404).json({ error: "approval not found" }); return; }
    if (row.status !== "APPROVED") {
      res.status(409).json({ error: `approval is ${String(row.status).toLowerCase()}, not approved` });
      return;
    }
    const env = row.resumeEnvelope as any;
    if (!env || env.kind !== "kernel_operation" || typeof env.operation !== "string") {
      res.status(422).json({ error: "approval has no kernel resume envelope" });
      return;
    }

    // Approver-modified params override the stored ones key-by-key (same
    // semantics the legacy dispatch gives modifiedParams).
    const params: Record<string, unknown> = {
      ...(env.params ?? {}),
      ...((row.modifiedParams as Record<string, unknown> | null) ?? {}),
    };

    ensureCapabilitiesRegistered();
    const { result, trace } = await executeOperation({
      operation: env.operation,
      params,
      context: env.context,
      // An approved write executes for real; the envelope only ever comes from
      // an autonomous run (the gate is bypassed in advisory/shadow).
      mode: "autonomous",
      approval: { approvedRef: approvalId },
    });

    console.log(
      `[agent-loop-resume] approval=${approvalId} op=${env.operation} → ${result.status}` +
        (result.status === "FAILED" || result.status === "BLOCKED" ? ` (${(result as any).reason})` : ""),
    );
    res.json({ data: { status: result.status, result, trace } });
  } catch (err: any) {
    console.error("[agent-loop-resume] failed:", err?.message);
    res.status(500).json({ error: err?.message || "resume execution failed" });
  }
});

export default router;
