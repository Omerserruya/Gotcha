/**
 * In-app notification routes for the current logged-in user.
 *
 *   GET    /notifications           - list, paginated, ?unreadOnly=true
 *   POST   /notifications/:id/mark-read
 *   POST   /notifications/mark-all-read
 *   GET    /notifications/unread-count
 *
 * Multi-tenant + per-user safety: every query is filtered by both the
 * authenticated user's tenantId AND their userId so no user can see
 * another user's notifications, even within the same tenant.
 */

import { Router, type Request, type Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, notificationCategory } from "@chatcenter/shared";
import { oneLanguage } from "../services/templates";
import { localeForRecipient } from "../services/platform-whatsapp";

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
  const page = hasMore ? rows.slice(0, limit) : rows;
  // `category` is derived on the way out, never stored. The row keeps the
  // SPECIFIC event that produced it - three different failures are three
  // different events - while the bell gets the one small enum it branches on.
  // Deriving also means historical rows classify under the current mapping
  // instead of under whatever was true the day they were written.
  // Rows written before 2026-10-08 hold both languages in one body: served in the reader's.
  const locale = await localeForRecipient(tenantId, userId);
  const data = page.map((r: any) => ({
    ...r,
    body: oneLanguage(r.body, locale),
    category: notificationCategory(r.eventType),
    target: { type: r.targetType ?? "none", id: r.targetId ?? null },
  }));
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
