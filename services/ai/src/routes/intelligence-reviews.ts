/**
 * Intelligence Reviews - human-review queue for uncertain/conflicting extracted
 * intelligence values (Customer Intelligence V2, Phase 2).
 *
 * Routes (mounted at /api/intelligence-reviews):
 *   GET    /            - list PENDING reviews (+ count)
 *   POST   /:id/approve - apply the proposed value as a MANUAL fact
 *   POST   /:id/reject  - discard the proposed value
 *
 * Auth: tenant ADMIN only.
 */

import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
} from "@chatcenter/shared";
import {
  listPendingReviews,
  countPendingReviews,
  approveReview,
  rejectReview,
} from "../services/intelligence-review.service";

const router = Router();
const guards = [authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN")];

router.get("/", ...guards, async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) { res.status(400).json({ error: "tenant required" }); return; }
  const [reviews, pending] = await Promise.all([
    listPendingReviews(tenantId),
    countPendingReviews(tenantId),
  ]);
  res.json({ ok: true, reviews, pending });
});

router.post("/:id/approve", ...guards, async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) { res.status(400).json({ error: "tenant required" }); return; }
  const ok = await approveReview(tenantId, String(req.params.id), (req as any).userId);
  if (!ok) { res.status(404).json({ error: "review not found or already resolved" }); return; }
  res.json({ ok: true });
});

router.post("/:id/reject", ...guards, async (req: Request, res: Response) => {
  const tenantId = req.tenantId;
  if (!tenantId) { res.status(400).json({ error: "tenant required" }); return; }
  const ok = await rejectReview(tenantId, String(req.params.id), (req as any).userId);
  if (!ok) { res.status(404).json({ error: "review not found or already resolved" }); return; }
  res.json({ ok: true });
});

export default router;
