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
import { resolveEntitlements, resolveLimit, resolveLimits, entitledIn } from "./entitlement-resolver";

export interface EffectiveEntitlement {
  key: string;
  valueType: EntitlementValueType;
  value: unknown; // boolean | number | object depending on valueType
  source: EntitlementSource;
}

/**
 * Resolve effective entitlements for a tenant.
 *
 * Delegates to the canonical resolver in `entitlement-resolver.ts` so there is
 * exactly ONE resolution path in the codebase - this signature is kept because
 * the billing service and the system console already consume it.
 */
export async function getEffectiveEntitlements(tenantId: string): Promise<Map<string, EffectiveEntitlement>> {
  const set = await resolveEntitlements(tenantId);
  const out = new Map<string, EffectiveEntitlement>();
  for (const e of set.entries.values()) {
    if (e.source === "CATALOG_DEFAULT") continue; // not a stored entitlement
    out.set(e.key, { key: e.key, valueType: e.valueType, value: e.value, source: e.source });
  }
  return out;
}

/** Numeric limits (COUNTER entitlements), keyed by entitlement key. */
export async function getLimits(tenantId: string): Promise<Record<string, number>> {
  return resolveLimits(tenantId);
}

/** A single COUNTER limit (e.g. "limit:ai_employees"). null = unlimited/unset. */
export async function getLimit(tenantId: string, key: string): Promise<number | null> {
  return resolveLimit(tenantId, key);
}

/**
 * Materialize BOOLEAN entitlements into TenantFeature rows so the existing
 * permission resolver (hasFeature/isPermissionLicensed) respects the effective
 * license with zero changes to that hot path. Idempotent; invalidates cache.
 */
export async function materializeEntitlements(tenantId: string, updatedBy?: string): Promise<void> {
  const set = await resolveEntitlements(tenantId);
  for (const e of set.entries.values()) {
    if (e.valueType !== "BOOLEAN") continue;
    // Route through the resolver's own check so the two hard guards - a
    // COMPLIANCE_DENY always denies, and an unbuilt capability is never
    // enabled - hold in the materialized cache too, not just at call time.
    const enabled = entitledIn(set, e.key);
    await prisma.tenantFeature.upsert({
      where: { tenantId_feature: { tenantId, feature: e.key } },
      create: { tenantId, feature: e.key, enabled, updatedBy },
      update: { enabled, updatedBy },
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
