import { Router, Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  prisma,
  authenticate,
  requireSystemAdmin,
  validate,
  crossTenantMiddleware,
  invalidatePermissionsCache,
  FEATURE_METADATA,
  ALL_FEATURES,
  isFeature,
  type Feature,
} from "@chatcenter/shared";

/**
 * SYSTEM_ADMIN - tenant feature management.
 *
 *   GET    /api/system/tenants/:tenantId/features            list all features + state for tenant
 *   PUT    /api/system/tenants/:tenantId/features/:feature   enable/disable a feature
 *   GET    /api/system/features                              registry (all features known to code)
 *
 * Each handler is gated by authenticate + requireSystemAdmin() and the
 * router opts into crossTenantMiddleware because SYSTEM_ADMIN legitimately
 * works across tenant boundaries.
 */

const router = Router();
router.use(crossTenantMiddleware);

// ─── Feature registry (metadata only - no DB read) ─────────────
router.get(
  "/features",
  authenticate,
  requireSystemAdmin(),
  (_req: Request, res: Response): void => {
    res.json({
      data: ALL_FEATURES.map((key) => FEATURE_METADATA[key]),
    });
  },
);

// ─── List tenant features ──────────────────────────────────────
router.get(
  "/tenants/:tenantId/features",
  authenticate,
  requireSystemAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.params.tenantId as string;
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const rows = await prisma.tenantFeature.findMany({ where: { tenantId } });
    const byKey = new Map(rows.map((r) => [r.feature, r]));

    // Merge with registry so the client always sees every known feature,
    // even ones that have never been toggled for this tenant.
    const data = ALL_FEATURES.map((feature) => {
      const row = byKey.get(feature);
      const meta = FEATURE_METADATA[feature];
      return {
        feature,
        displayName: meta.displayName,
        description: meta.description,
        category: meta.category,
        enabled: row?.enabled ?? meta.defaultEnabled,
        config: row?.config ?? null,
        configured: !!row, // false = inheriting metadata default
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    });

    res.json({ data });
  },
);

// ─── Update tenant feature ─────────────────────────────────────
const updateFeatureSchema = z.object({
  enabled: z.boolean(),
  config: z.record(z.unknown()).nullable().optional(),
});

router.put(
  "/tenants/:tenantId/features/:feature",
  authenticate,
  requireSystemAdmin(),
  validate(updateFeatureSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.params.tenantId as string;
    const feature = req.params.feature as string;
    if (!isFeature(feature)) {
      res.status(400).json({ error: "Unknown feature", feature });
      return;
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const { enabled, config } = req.body as { enabled: boolean; config?: Record<string, unknown> | null };

    const row = await prisma.tenantFeature.upsert({
      where: { tenantId_feature: { tenantId, feature: feature as Feature } },
      create: {
        tenantId,
        feature,
        enabled,
        config: config === null || config === undefined ? Prisma.JsonNull : (config as Prisma.InputJsonValue),
        updatedBy: req.user?.userId,
      },
      update: {
        enabled,
        config:
          config === null
            ? Prisma.JsonNull
            : config === undefined
              ? undefined
              : (config as Prisma.InputJsonValue),
        updatedBy: req.user?.userId,
      },
    });

    invalidatePermissionsCache({ tenantId });
    res.json({ data: row });
  },
);

export default router;
