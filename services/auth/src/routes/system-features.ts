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
  ALL_LICENSE_KEYS,
  setTenantEntitlement,
  getEffectiveEntitlements,
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

// ─────────────────────────────────────────────────────────────
// Entitlements, credits & POC — the special-tenant admin surface.
//
// Feature LICENSING (what the tenant's plan/contract allows) is separate from
// the raw feature FLAGS above: it is written as TenantEntitlement rows
// (OVERRIDE for manual grants, TRIAL for POC windows), materialized into
// TenantFeature, and consumed by the permission resolver — so a disabled
// domain disappears from /api/permissions/me and the workspace UI hides it.
// Money/wallet operations go through the billing service's internal API.
// ─────────────────────────────────────────────────────────────

const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

async function billingInternal(path: string, init?: { method?: string; body?: unknown }): Promise<any | null> {
  try {
    const res = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026",
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { error: body?.error || `billing_${res.status}` };
    }
    return await res.json();
  } catch (err: any) {
    return { error: err?.message || "billing_unreachable" };
  }
}

/** The 9 top-level license domains ("conversation", "analytics", …). */
const LICENSE_DOMAINS: string[] = Array.from(new Set(ALL_LICENSE_KEYS.map((k) => k.split(":")[0] as string))).sort();

// ─── Read the tenant's license + billing snapshot ──────────────
router.get(
  "/tenants/:tenantId/entitlements",
  authenticate,
  requireSystemAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.params.tenantId as string;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

    const [effective, rows, entitlementRows, billing] = await Promise.all([
      getEffectiveEntitlements(tenantId),
      prisma.tenantFeature.findMany({ where: { tenantId, feature: { in: LICENSE_DOMAINS } }, select: { feature: true, enabled: true } }),
      prisma.tenantEntitlement.findMany({ where: { tenantId, entitlementKey: { in: LICENSE_DOMAINS } }, select: { entitlementKey: true, source: true, expiresAt: true } }),
      billingInternal(`summary?tenantId=${encodeURIComponent(tenantId)}`),
    ]);
    const byKey = new Map(rows.map((r) => [r.feature, r.enabled]));
    const overrideByKey = new Map(entitlementRows.map((r) => [r.entitlementKey, r]));

    res.json({
      data: {
        domains: LICENSE_DOMAINS.map((key) => ({
          key,
          // License semantics: no row → allowed (packaging default-ALLOW).
          enabled: byKey.get(key) ?? true,
          source: effective.get(key)?.source ?? null,
          expiresAt: overrideByKey.get(key)?.expiresAt ?? null,
        })),
        billing: billing?.error ? { error: billing.error } : { subscription: billing?.subscription ?? null, balance: billing?.balance ?? null },
      },
    });
  },
);

// ─── Toggle a licensed domain (manual OVERRIDE — strongest source) ─
const entitlementSchema = z.object({ enabled: z.boolean() });
router.put(
  "/tenants/:tenantId/entitlements/:key",
  authenticate,
  requireSystemAdmin(),
  validate(entitlementSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.params.tenantId as string;
    const key = req.params.key as string;
    if (!ALL_LICENSE_KEYS.includes(key)) { res.status(400).json({ error: "Unknown license key", key }); return; }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

    await setTenantEntitlement({
      tenantId,
      key,
      valueType: "BOOLEAN",
      value: (req.body as { enabled: boolean }).enabled,
      source: "OVERRIDE",
      reason: "system console",
      createdBy: req.user?.userId,
    });
    res.json({ data: { key, enabled: (req.body as { enabled: boolean }).enabled } });
  },
);

// ─── POC setup: credits + feature set + optional expiry, no card ─
const pocSchema = z.object({
  credits: z.number().positive().max(1_000_000),
  expiresAt: z.string().datetime().optional(),
  // Feature domains the POC may use. Omitted → all domains enabled.
  features: z.array(z.string()).optional(),
});
router.post(
  "/tenants/:tenantId/poc",
  authenticate,
  requireSystemAdmin(),
  validate(pocSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.params.tenantId as string;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

    const { credits, expiresAt, features } = req.body as { credits: number; expiresAt?: string; features?: string[] };
    const expiry = expiresAt ? new Date(expiresAt) : null;
    if (expiry && expiry <= new Date()) { res.status(400).json({ error: "expiresAt must be in the future" }); return; }
    const picked = features ? new Set(features) : null;
    if (picked) {
      for (const f of picked) {
        if (!LICENSE_DOMAINS.includes(f)) { res.status(400).json({ error: "Unknown feature domain", domain: f }); return; }
      }
    }

    // Feature set: license default-ALLOW means absent rows = allowed, so an
    // exact POC feature set needs EXPLICIT rows for every domain — true for
    // picked, false for the rest — all TRIAL-source with the POC's expiry.
    for (const domain of LICENSE_DOMAINS) {
      await setTenantEntitlement({
        tenantId,
        key: domain,
        valueType: "BOOLEAN",
        value: picked ? picked.has(domain) : true,
        source: "TRIAL",
        expiresAt: expiry,
        reason: "POC provisioning",
        createdBy: req.user?.userId,
      });
    }

    // Money side: enforced subscription + the operator-set credit budget.
    const billing = await billingInternal("setup-poc", {
      method: "POST",
      body: { tenantId, credits, expiresAt: expiry?.toISOString() ?? null, actor: req.user?.userId },
    });
    if (billing?.error) { res.status(502).json({ error: `POC billing setup failed: ${billing.error}` }); return; }

    res.json({ data: { ok: true, credits, expiresAt: expiry, features: picked ? Array.from(picked) : LICENSE_DOMAINS, balance: billing?.balance ?? null } });
  },
);

// ─── Credit top-up (never expires) ──────────────────────────────
const creditsSchema = z.object({ units: z.number().positive().max(1_000_000) });
router.post(
  "/tenants/:tenantId/credits",
  authenticate,
  requireSystemAdmin(),
  validate(creditsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.params.tenantId as string;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    const billing = await billingInternal("grant-credits", {
      method: "POST",
      body: { tenantId, units: (req.body as { units: number }).units, actor: req.user?.userId },
    });
    if (billing?.error) { res.status(502).json({ error: `Credit grant failed: ${billing.error}` }); return; }
    res.json({ data: { ok: true, balance: billing?.balance ?? null } });
  },
);

export default router;
