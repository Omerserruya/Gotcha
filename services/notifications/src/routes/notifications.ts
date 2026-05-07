/**
 * In-app notification routes for the current logged-in user.
 *
 *   GET    /notifications           — list, paginated, ?unreadOnly=true
 *   POST   /notifications/:id/mark-read
 *   POST   /notifications/mark-all-read
 *   GET    /notifications/unread-count
 *
 * Multi-tenant + per-user safety: every query is filtered by both the
 * authenticated user's tenantId AND their userId so no user can see
 * another user's notifications, even within the same tenant.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";

const router = Router();

router.use("/notifications", authenticate, resolveTenant, requireActiveTenant());

// ─── List ─────────────────────────────────────────────────

router.get("/notifications", async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const tenantId = req.tenantId as string;
  const unreadOnly = String(req.query.unreadOnly || "").toLowerCase() === "true";
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

  const where: any = { tenantId, userId };
  if (unreadOnly) where.read = false;

  const rows = await (prisma as any).inAppNotification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    data,
    nextCursor: hasMore ? data[data.length - 1]?.id : null,
  });
});

// ─── Unread count ─────────────────────────────────────────

router.get("/notifications/unread-count", async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const tenantId = req.tenantId as string;
  const count = await (prisma as any).inAppNotification.count({
    where: { tenantId, userId, read: false },
  });
  res.json({ count });
});

// ─── Mark single ──────────────────────────────────────────

router.post("/notifications/:id/mark-read", async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const tenantId = req.tenantId as string;
  // updateMany so a stale id (or another user's row) silently no-ops without
  // leaking existence info. Returns count for the caller's confirmation.
  const result = await (prisma as any).inAppNotification.updateMany({
    where: { id: req.params.id, tenantId, userId },
    data: { read: true },
  });
  if (result.count === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

// ─── Mark all ─────────────────────────────────────────────

router.post("/notifications/mark-all-read", async (req: Request, res: Response) => {
  const userId = (req as any).user?.userId as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const tenantId = req.tenantId as string;
  await (prisma as any).inAppNotification.updateMany({
    where: { tenantId, userId, read: false },
    data: { read: true },
  });
  res.json({ ok: true });
});

export default router;
