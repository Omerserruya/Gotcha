/**
 * Customer Snapshot API - the primary intelligence read surface (V2, Phase 3).
 *
 * GET /api/customer-snapshot?conversationId=...   (inbox / conversation header)
 * GET /api/customer-snapshot?identityKey=...       (contact profile / CRM panel)
 *
 * Returns the generated Snapshot projection (WHO / WHAT / NOW / MISSING / NEXT
 * / NARRATIVE). Read-only; any authenticated agent in an active tenant.
 */

import { Router, type Request, type Response } from "express";
import { authenticate, resolveTenant, requireActiveTenant } from "@chatcenter/shared";
import { buildCustomerSnapshot } from "../services/customer-snapshot.service";

const router = Router();

router.get(
  "/",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request & { tenantId?: string }, res: Response) => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenant required" });
      return;
    }
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
    const identityKey = typeof req.query.identityKey === "string" ? req.query.identityKey : undefined;
    if (!conversationId && !identityKey) {
      res.status(400).json({ error: "conversationId or identityKey is required" });
      return;
    }
    try {
      const snapshot = await buildCustomerSnapshot({ tenantId, conversationId, identityKey });
      res.json({ ok: true, snapshot });
    } catch (err: any) {
      console.error("[customer-snapshot] build failed:", err?.message ?? err);
      res.status(500).json({ error: "failed to build snapshot" });
    }
  },
);

export default router;
