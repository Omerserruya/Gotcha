/**
 * Approval request REST surface.
 *
 * Owns the human-facing side of the F4 bot-surface approval flow:
 *   - GET  /api/approvals               — list for tenant (optional filters)
 *   - GET  /api/approvals/:id           — single, with full rich-card data
 *   - POST /api/approvals/:id/approve   — human clicks Approve
 *   - POST /api/approvals/:id/reject    — human clicks Reject with reason
 *
 * The "actually run the approved action" step does NOT live here — that
 * stays in the bot engine / action-executor. This route only transitions
 * ApprovalRequest.status and records the human's decision. The bot
 * engine's resume-on-approval worker picks up APPROVED rows, dispatches
 * them through executeAction() with approved=true, and advances the
 * paused conversation.
 *
 * Separation of concerns: REST mutates approval state; executor runs
 * the tool; audit log captures both. See memory/bug_f4_approval_wrong_surface.md.
 */
import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  approveRequest,
  rejectRequest,
  findPendingByConversation,
  publishEvent,
} from "@chatcenter/shared";

/**
 * Dispatch an approved action by calling the ai service's action
 * executor over HTTP. We POST a single-step plan with approved=true so
 * the executor's gate recognizes the approval. Best-effort: failure
 * here logs an error but does NOT roll the ApprovalRequest back to
 * PENDING — the human already decided. A follow-up worker can retry.
 */
async function dispatchApprovedAction(args: {
  tenantId: string;
  approvalId: string;
  tool: string;
  params: Record<string, unknown>;
  approvedBy: string;
  authToken?: string;
}): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  const base = process.env.AI_SERVICE_URL ?? "http://ai:4006";
  const url = `${base.replace(/\/$/, "")}/api/action-planner/execute`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = args.authToken ?? process.env.INTERNAL_SERVICE_TOKEN;
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = args.tenantId;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        plan: {
          summary: `Approved action: ${args.tool}`,
          requiresApproval: true,
          steps: [
            {
              tool: args.tool,
              params: args.params,
              reason: `Human-approved via approval request ${args.approvalId}`,
              riskLevel: "high",
            },
          ],
        },
        approved: true,
        approvedBy: args.approvedBy,
        idempotencyKey: `approval:${args.approvalId}`,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `executor returned ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, result: data };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "fetch failed" };
  }
}

const router = Router();
router.use(authenticate, resolveTenant, requireActiveTenant());

/**
 * GET /api/approvals
 * List approval requests for this tenant. Supports:
 *   - ?status=PENDING       default
 *   - ?conversationId=xxx   scope to one conversation
 *   - ?contactId=xxx        scope to one contact
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const status = (req.query.status as string | undefined) ?? "PENDING";
    const conversationId = req.query.conversationId as string | undefined;
    const contactId = req.query.contactId as string | undefined;

    const where: any = { tenantId, status };
    if (conversationId) where.conversationId = conversationId;
    if (contactId) where.contactId = contactId;

    const rows = await (prisma as any).approvalRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return res.json({ data: rows });
  } catch (err: any) {
    console.error("approvals.list error:", err);
    return res.status(500).json({ error: "Failed to list approvals" });
  }
});

/**
 * GET /api/approvals/:id
 * Full record + enrichment for the rich in-conversation approval card:
 *   - conversation + recent messages (last 5)
 *   - contact snapshot
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });

    // Load the surrounding context so the frontend card doesn't need
    // N extra round trips.
    const [conversation, contact, recentMessages] = await Promise.all([
      prisma.conversation.findFirst({
        where: { id: row.conversationId, tenantId },
      }),
      row.contactId
        ? prisma.contact.findFirst({ where: { id: row.contactId, tenantId } })
        : Promise.resolve(null),
      prisma.message.findMany({
        where: { conversationId: row.conversationId, tenantId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          direction: true,
          body: true,
          createdAt: true,
          senderName: true,
        },
      }),
    ]);

    return res.json({
      approval: row,
      conversation,
      contact,
      recentMessages: recentMessages.reverse(),
    });
  } catch (err: any) {
    console.error("approvals.get error:", err);
    return res.status(500).json({ error: "Failed to load approval" });
  }
});

/**
 * POST /api/approvals/:id/approve
 * Body: { decisionReason?, modifiedParams? }
 *
 * Separation of duties: the approver MUST NOT be the same actor who
 * authored the originating bot action. For bot-initiated requests
 * (requestedBy starts with "bot" / "flow:" / "ai-agent:") this is
 * trivially satisfied — the actor is the bot, not a human. For
 * human-initiated requests (rare under the F4 model), we reject
 * same-actor approvals.
 */
router.post("/:id/approve", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const actorId = (req as any).user?.id;
    if (!actorId) return res.status(401).json({ error: "authentication required" });

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });
    if (row.status !== "PENDING") {
      return res.status(409).json({ error: `approval is already ${row.status.toLowerCase()}` });
    }
    if (row.expiresAt && row.expiresAt < new Date()) {
      return res.status(409).json({ error: "approval has expired" });
    }
    // Same-actor defense-in-depth
    if (row.requestedBy === actorId) {
      return res.status(403).json({
        error: "approver must be a different actor than the requester",
      });
    }

    const effectiveParams =
      req.body?.modifiedParams && typeof req.body.modifiedParams === "object"
        ? (req.body.modifiedParams as Record<string, unknown>)
        : (row.params as Record<string, unknown>);

    const updated = await approveRequest(
      tenantId,
      row.id,
      actorId,
      req.body?.modifiedParams,
      req.body?.decisionReason,
    );

    // Un-pause the conversation so the bot can resume on next inbound
    // (or so the dispatched action's side effect lands cleanly). We
    // reset handledBy back to ai_bot — the resume path re-establishes
    // the autonomous loop. If the tenant later wants "hand to human
    // after approval" they can express it via policy.
    try {
      await prisma.conversation.update({
        where: { id: row.conversationId },
        data: { handledBy: "ai_bot" },
      });
    } catch (err: any) {
      console.error("approvals.approve: failed to un-pause conversation:", err.message);
    }

    // Fire the approved action via the ai service executor. Best-effort:
    // failure is logged but does NOT roll back the approval record.
    const authToken = (req.headers.authorization as string | undefined) ?? undefined;
    const dispatch = await dispatchApprovedAction({
      tenantId,
      approvalId: row.id,
      tool: row.tool,
      params: effectiveParams,
      approvedBy: actorId,
      authToken,
    });
    if (!dispatch.ok) {
      console.error(
        `[approvals] dispatch failed for ${row.id}: ${dispatch.error}`,
      );
    }

    // Notify subscribers (inbox UIs, worker retry, etc.)
    publishEvent({
      event: "approval:approved",
      tenantId,
      data: {
        approvalId: row.id,
        conversationId: row.conversationId,
        tool: row.tool,
        dispatchOk: dispatch.ok,
      },
    }).catch(() => {});

    return res.json({
      approval: updated,
      dispatch: {
        ok: dispatch.ok,
        error: dispatch.error,
      },
    });
  } catch (err: any) {
    console.error("approvals.approve error:", err);
    return res.status(500).json({ error: "Failed to approve" });
  }
});

/**
 * POST /api/approvals/:id/reject
 * Body: { decisionReason }
 * Rejection reason is REQUIRED — no silent "just no". The bot resume
 * worker uses it to craft the fallback customer message.
 */
router.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const actorId = (req as any).user?.id;
    if (!actorId) return res.status(401).json({ error: "authentication required" });
    const { decisionReason } = req.body ?? {};
    if (!decisionReason || typeof decisionReason !== "string") {
      return res.status(400).json({ error: "decisionReason is required" });
    }

    const row = await (prisma as any).approvalRequest.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!row) return res.status(404).json({ error: "approval not found" });
    if (row.status !== "PENDING") {
      return res.status(409).json({ error: `approval is already ${row.status.toLowerCase()}` });
    }

    const updated = await rejectRequest(tenantId, row.id, actorId, decisionReason);

    // Un-pause the conversation but route to human. Rejected actions
    // mean the bot shouldn't retry — hand off to a human so they can
    // respond directly.
    try {
      await prisma.conversation.update({
        where: { id: row.conversationId },
        data: { handledBy: "human", isHandedOver: true },
      });
    } catch (err: any) {
      console.error("approvals.reject: failed to reroute conversation:", err.message);
    }

    publishEvent({
      event: "approval:rejected",
      tenantId,
      data: {
        approvalId: row.id,
        conversationId: row.conversationId,
        tool: row.tool,
        reason: decisionReason,
      },
    }).catch(() => {});

    return res.json({ approval: updated });
  } catch (err: any) {
    console.error("approvals.reject error:", err);
    return res.status(500).json({ error: "Failed to reject" });
  }
});

export default router;
