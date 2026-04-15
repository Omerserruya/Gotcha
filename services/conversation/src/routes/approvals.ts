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
} from "@chatcenter/shared";

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

    const updated = await approveRequest(
      tenantId,
      row.id,
      actorId,
      req.body?.modifiedParams,
      req.body?.decisionReason,
    );
    return res.json({ approval: updated });
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
    return res.json({ approval: updated });
  } catch (err: any) {
    console.error("approvals.reject error:", err);
    return res.status(500).json({ error: "Failed to reject" });
  }
});

export default router;
