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
import { getFeatureDef, featuresByCategory } from "./feature-catalog";

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
  /** The voice license's answer, if this tenant has one recorded at all. */
  let voiceLicensed: boolean | undefined;
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
    // Some capabilities are guarded by a gate that reads the LEGACY key
    // (`shopify_live_chat`) rather than the canonical one
    // (`commerce.shopify_live_chat`). Both are rows in this same table, so
    // writing only the canonical row leaves the guard reading a row this
    // function never touches - the plan would grant or withhold the capability
    // and the gate protecting it would never see the change.
    //
    // Writing the legacy row here is what makes the commercial answer reach
    // `requireFeature`, with no second gate and no extra read on the route.
    const legacy = getFeatureDef(e.key)?.materializesTo;
    if (legacy) {
      await prisma.tenantFeature.upsert({
        where: { tenantId_feature: { tenantId, feature: legacy } },
        create: { tenantId, feature: legacy, enabled, updatedBy },
        update: { enabled, updatedBy },
      });
    }

    if (e.key === "voice") voiceLicensed = enabled;
  }

  // ── The voice license, projected onto the two gates that actually guard it ──
  //
  // Voice was sold in one place and enforced in three, none of them connected:
  //
  //   1. the POC / plan feature area (a LICENSE key),
  //   2. `Tenant.voiceCopilotEnabled` + siblings - columns that predate
  //      entitlements, settable only by a SYSTEM_ADMIN, which decide whether
  //      /settings/voice-channels exists at all,
  //   3. `requireEntitlement("voice.call_pilot")` on POST /voice-channels - a
  //      FEATURE key in the plan catalog, defaulting to FALSE.
  //
  // So a customer sold a voice POC hit a 402 the moment they submitted their
  // Twilio credentials, having already had the flags flipped by hand for them.
  // Measured on production: all three tenant columns true, zero `voice%` rows in
  // tenant_features, no `voice.call_pilot` entitlement anywhere.
  //
  // The license is now the single commercial act, projected here - the same
  // shape as the `materializesTo` bridge above. Only ever when an EXPLICIT
  // `voice` row exists: license semantics are default-ALLOW and telephony costs
  // real money, so "nobody decided" must never read as "yes".
  if (voiceLicensed !== undefined) {
    await prisma.tenant.update({
      where: { id: tenantId },
      // Between entitlement changes these remain an operational override (kill
      // a tenant's telephony now, without touching their plan); the next
      // materialize restores the licensed answer.
      data: {
        voiceCopilotEnabled: voiceLicensed,
        voiceInboxUiEnabled: voiceLicensed,
        voiceIncomingEnabled: voiceLicensed,
      },
    });

    // Driven by the catalog's own category, so a voice capability added later
    // is covered without anyone remembering this line exists.
    for (const f of featuresByCategory("VOICE")) {
      if (!f.implemented) continue;
      // An explicit per-feature entitlement is a more specific decision than
      // the blanket license and has already been written by the loop above.
      // Leave it alone: a plan that deliberately withholds one voice capability
      // must not have it handed back by the licence that grants the rest.
      if (set.entries.has(f.key)) continue;
      await prisma.tenantFeature.upsert({
        where: { tenantId_feature: { tenantId, feature: f.key } },
        create: { tenantId, feature: f.key, enabled: voiceLicensed, updatedBy },
        update: { enabled: voiceLicensed, updatedBy },
      });
    }
  }

  invalidatePermissionsCache({ tenantId });
}


/** The license key that stands for "this organization has telephony". */
const VOICE_LICENSE_KEY = "voice";

/**
 * Voice channels a tenant may connect once voice is licensed but no plan or
 * operator has said otherwise. Mirrors the `ai_voice` plan, so a pilot behaves
 * like the product it is a pilot of.
 */
const DEFAULT_VOICE_CHANNELS = 5;

/**
 * Write the capability rows the voice license implies.
 *
 * Category-driven, so a voice capability added to the catalog later is covered
 * without anyone remembering this function exists.
 */
async function expandVoiceLicense(input: {
  tenantId: string;
  value: unknown;
  source: EntitlementSource;
  expiresAt?: Date | null;
  reason?: string;
  createdBy?: string;
}): Promise<void> {
  const granted = input.value === true || (input.value as { bool?: boolean } | null)?.bool === true;

  for (const f of featuresByCategory("VOICE")) {
    if (!f.implemented) continue;
    await prisma.tenantEntitlement.upsert({
      where: {
        tenantId_entitlementKey_source: {
          tenantId: input.tenantId,
          entitlementKey: f.key,
          source: input.source,
        },
      },
      create: {
        tenantId: input.tenantId,
        entitlementKey: f.key,
        valueType: "BOOLEAN",
        value: { bool: granted } as any,
        source: input.source,
        expiresAt: input.expiresAt ?? null,
        reason: input.reason ?? "voice license",
        createdBy: input.createdBy,
      },
      update: {
        valueType: "BOOLEAN",
        value: { bool: granted } as any,
        expiresAt: input.expiresAt ?? null,
        reason: input.reason ?? "voice license",
        createdBy: input.createdBy,
      },
    });
  }

  // The gate immediately behind the feature check is
  // requireCapacity("limit:voice_channels"), which defaults to 0 - so without
  // this a licensed tenant clears one refusal and meets the next with their
  // Twilio credentials already typed in. Only ever written when there is no
  // decision recorded for this tenant already: a plan that sells a different
  // number, or an operator who set one by hand, is the more specific answer.
  if (granted) {
    const existing = await prisma.tenantEntitlement.findFirst({
      where: { tenantId: input.tenantId, entitlementKey: "limit:voice_channels" },
      select: { id: true },
    });
    if (!existing) {
      await prisma.tenantEntitlement.create({
        data: {
          tenantId: input.tenantId,
          entitlementKey: "limit:voice_channels",
          valueType: "COUNTER",
          value: { count: DEFAULT_VOICE_CHANNELS } as any,
          source: input.source,
          expiresAt: input.expiresAt ?? null,
          reason: input.reason ?? "voice license",
          createdBy: input.createdBy,
        },
      });
    }
  }
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

  // Granting the voice LICENSE has to grant the voice CAPABILITIES, because
  // they are what the gates ask for.
  //
  // POST /voice-channels mounts requireEntitlement("voice.call_pilot"), which
  // resolves through resolveEntitlements - plan entitlements, tenant overrides,
  // catalog defaults. It never reads tenant_features. So projecting the license
  // into that materialized cache (which materializeEntitlements does, for the
  // permission resolver and the tenant's voice columns) left the 402 exactly
  // where it was: `voice.call_pilot` still fell through to its catalog default
  // of false, and a customer who had been SOLD voice still could not connect
  // Twilio.
  //
  // Writing real entitlement rows is what reaches the resolver. Same source and
  // same expiry as the license, so they rise and fall with it: a POC's TRIAL
  // grant drops out on the same day, and a COMPLIANCE_DENY (rank 100) still
  // outranks all of it.
  if (input.key === VOICE_LICENSE_KEY && input.valueType === "BOOLEAN") {
    await expandVoiceLicense(input);
  }

  if (input.valueType === "BOOLEAN") await materializeEntitlements(input.tenantId, input.createdBy);
}
