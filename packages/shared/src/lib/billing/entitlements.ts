/**
 * Entitlement layering - the layer the dossier calls for:
 *
 *   Plan defaults (PlanEntitlement)
 *        ⊕  Tenant overrides (TenantEntitlement: OVERRIDE/PROMO/TRIAL/ADDON/BETA)
 *        →  Effective entitlements
 *        →  materialized into TenantFeature (the fast read cache permissions.ts
 *           already consumes) so beta/promo/trial/override coexist with plan
 *           defaults WITHOUT destroying each other.
 *
 * This decouples licensing from plans: a tenant can be entitled to features and
 * limits for reasons billing knows nothing about (manual grant, promo, contract).
 *
 *   • BOOLEAN entitlements → TenantFeature.enabled (feature gating).
 *   • COUNTER entitlements → numeric limits (max users / AI employees / channels
 *     / storage / included units) read via getLimits().
 *   • CONFIG  entitlements → arbitrary JSON read via getEffectiveEntitlements().
 */
import { prisma } from "../prisma";
import { invalidatePermissionsCache } from "../permissions";
import type { EntitlementValueType, EntitlementSource } from "@prisma/client";

export interface EffectiveEntitlement {
  key: string;
  valueType: EntitlementValueType;
  value: unknown; // boolean | number | object depending on valueType
  source: EntitlementSource;
}

// Override precedence: the strongest non-plan source wins over PLAN_DEFAULT.
const SOURCE_RANK: Record<EntitlementSource, number> = {
  PLAN_DEFAULT: 0,
  ADDON: 1,
  PROMO: 2,
  TRIAL: 3,
  BETA: 4,
  OVERRIDE: 5, // explicit manual override always wins
};

/**
 * Resolve effective entitlements for a tenant: the active plan's defaults
 * overlaid with non-expired tenant overrides (highest-ranked source wins).
 */
export async function getEffectiveEntitlements(tenantId: string): Promise<Map<string, EffectiveEntitlement>> {
  const out = new Map<string, EffectiveEntitlement>();

  // 1) Plan defaults from the tenant's subscription (via its billable entity).
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId },
    include: { entity: { include: { subscription: true } } },
  });
  const sub = link?.entity.subscription;
  if (sub) {
    const plan = await prisma.plan.findUnique({
      where: { key_version: { key: sub.planKey, version: sub.planVersion } },
      include: { entitlements: true },
    });
    for (const e of plan?.entitlements ?? []) {
      out.set(e.entitlementKey, { key: e.entitlementKey, valueType: e.valueType, value: e.value, source: "PLAN_DEFAULT" });
    }
  }

  // 2) Tenant overrides (skip expired).
  const now = new Date();
  const overrides = await prisma.tenantEntitlement.findMany({ where: { tenantId } });
  for (const o of overrides) {
    if (o.expiresAt && o.expiresAt <= now) continue;
    const existing = out.get(o.entitlementKey);
    if (!existing || SOURCE_RANK[o.source] >= SOURCE_RANK[existing.source]) {
      out.set(o.entitlementKey, { key: o.entitlementKey, valueType: o.valueType, value: o.value, source: o.source });
    }
  }
  return out;
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (v && typeof v === "object" && "bool" in (v as any)) return Boolean((v as any).bool);
  return Boolean(v);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "count" in (v as any)) return Number((v as any).count);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Numeric limits (COUNTER entitlements), keyed by entitlement key. */
export async function getLimits(tenantId: string): Promise<Record<string, number>> {
  const eff = await getEffectiveEntitlements(tenantId);
  const limits: Record<string, number> = {};
  for (const e of eff.values()) {
    if (e.valueType === "COUNTER") {
      const n = asNumber(e.value);
      if (n != null) limits[e.key] = n;
    }
  }
  return limits;
}

/** A single COUNTER limit (e.g. "limit:ai_employees"). null = unlimited/unset. */
export async function getLimit(tenantId: string, key: string): Promise<number | null> {
  const limits = await getLimits(tenantId);
  return key in limits ? limits[key] : null;
}

/**
 * Materialize BOOLEAN entitlements into TenantFeature rows so the existing
 * permission resolver (hasFeature/isPermissionLicensed) respects the effective
 * license with zero changes to that hot path. Idempotent; invalidates cache.
 */
export async function materializeEntitlements(tenantId: string, updatedBy?: string): Promise<void> {
  const eff = await getEffectiveEntitlements(tenantId);
  for (const e of eff.values()) {
    if (e.valueType !== "BOOLEAN") continue;
    await prisma.tenantFeature.upsert({
      where: { tenantId_feature: { tenantId, feature: e.key } },
      create: { tenantId, feature: e.key, enabled: asBool(e.value), updatedBy },
      update: { enabled: asBool(e.value), updatedBy },
    });
  }
  invalidatePermissionsCache({ tenantId });
}

/** Upsert a single tenant override (beta/promo/trial/manual/add-on). */
export async function setTenantEntitlement(input: {
  tenantId: string;
  key: string;
  valueType: EntitlementValueType;
  value: unknown;
  source: EntitlementSource;
  expiresAt?: Date | null;
  reason?: string;
  createdBy?: string;
}): Promise<void> {
  await prisma.tenantEntitlement.upsert({
    where: { tenantId_entitlementKey_source: { tenantId: input.tenantId, entitlementKey: input.key, source: input.source } },
    create: {
      tenantId: input.tenantId,
      entitlementKey: input.key,
      valueType: input.valueType,
      value: input.value as any,
      source: input.source,
      expiresAt: input.expiresAt ?? null,
      reason: input.reason,
      createdBy: input.createdBy,
    },
    update: {
      valueType: input.valueType,
      value: input.value as any,
      expiresAt: input.expiresAt ?? null,
      reason: input.reason,
      createdBy: input.createdBy,
    },
  });
  if (input.valueType === "BOOLEAN") await materializeEntitlements(input.tenantId, input.createdBy);
}
