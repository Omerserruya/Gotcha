/**
 * Industry Packs - catalog + apply API (Customer Intelligence V2, Phase 1).
 *
 * Routes (mounted at /api/industry-packs):
 *   GET  /         - list system packs + this tenant's cloned packs
 *   POST /apply    - body { slug } → clone the pack's scope-tagged field
 *                    templates into per-tenant FieldDefinition rows and set
 *                    BusinessProfile.packSlug.
 *
 * Auth: tenant ADMIN only.
 */

import { Router, type Request, type Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  requireRole,
} from "@chatcenter/shared";
import { listPacks, applyPack } from "../services/intelligence-registry.service";

const router = Router();

router.get(
  "/",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenant required" });
      return;
    }
    const packs = await listPacks(tenantId);
    res.json({ ok: true, packs });
  },
);

router.post(
  "/apply",
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "tenant required" });
      return;
    }
    const slug = typeof req.body?.slug === "string" ? req.body.slug.trim() : "";
    if (!slug) {
      res.status(400).json({ error: "slug is required" });
      return;
    }
    const result = await applyPack(tenantId, slug);
    if (!result) {
      res.status(404).json({ error: `pack not found: ${slug}` });
      return;
    }
    res.json({ ok: true, ...result });
  },
);

export default router;
