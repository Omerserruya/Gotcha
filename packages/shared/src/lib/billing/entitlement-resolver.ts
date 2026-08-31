/**
 * The canonical organization entitlement resolver.
 *
 * ONE function answers "what is this organization entitled to?", and every
 * server-side gate goes through it. Frontend visibility mirrors the answer but
 * is never authoritative.
 *
 * Precedence (highest wins)
 * -------------------------
 *   7. COMPLIANCE_DENY      explicit security/compliance kill switch - always
 *                           wins and always denies, regardless of what was paid
 *   6. OVERRIDE             manual organization-specific override
 *   5. BETA                 time-boxed beta access
 *   4. TRIAL                POC / Trial grant
 *   3. PROMO                temporary promotional grant
 *   2. ADDON                purchased add-on
 *   1. VOLUME_OPTION        entitlements granted by the selected chat/voice
 *                           volume option on the active subscription
 *   0. PLAN_DEFAULT         the active subscription's PlanVersion. A CUSTOM
 *                           plan is a PlanVersion, so negotiated terms arrive
 *                           through this layer with no special casing.
 *
 * Below all of it sits the catalog default (`FeatureDefinition.defaultValue`),
 * used only when no layer supplies a value at all.
 *
 * Two hard rules:
 *   • A capability the product has not built (`implemented: false`) is DENIED no
 *     matter what any layer says. You cannot accidentally sell vapour.
 *   • Resolution failures fail CLOSED for paid capabilities and OPEN for the
 *     always-included core, so a database blip never silently unlocks AI
 *     Employee and never locks a paying customer out of their own inbox.
 */
import { prisma } from "../prisma";
import type { EntitlementSource, EntitlementValueType } from "@prisma/client";
import {
  getFeatureDef,
  isUnsellable,
  UNLIMITED_LIMIT,
  LIMIT_KEYS,
} from "./feature-catalog";

export interface ResolvedEntitlement {
  key: string;
  valueType: EntitlementValueType;
  value: unknown;
  source: EntitlementSource | "CATALOG_DEFAULT";
}

export interface EntitlementSet {
  tenantId: string;
  planKey: string | null;
  planVersion: number | null;
  entries: Map<string, ResolvedEntitlement>;
  /** True when the tenant has no subscription at all (pre-billing tenants). */
  unsubscribed: boolean;
}

/**
 * Precedence rank. Higher wins. COMPLIANCE_DENY sits above everything.
 *
 * The numbers are internal and never persisted, so they are renumbered when
 * something is inserted rather than wedged in with a tie. A tie would be
 * resolved by whichever TenantEntitlement row happened to be read first, and
 * "which of your capabilities you have depends on row order" is not a rule
 * anyone can reason about.
 *
 * SHOPIFY_SUBSCRIPTION sits just below ADDON: it grants what a confirmed,
 * currently-active Shopify subscription pays for, so it must beat PLAN_DEFAULT
 * - otherwise a plan default would mask the fact that Shopify has stopped
 * paying - while an ADDON the customer bought from GOTCHA directly, and any
 * OVERRIDE a human deliberately set, both still win over it.
 */
const SOURCE_RANK: Record<EntitlementSource, number> = {
  PLAN_DEFAULT: 0,
  VOLUME_OPTION: 1,
  SHOPIFY_SUBSCRIPTION: 2,
  ADDON: 3,
  PROMO: 4,
  TRIAL: 5,
  BETA: 6,
  OVERRIDE: 7,
  COMPLIANCE_DENY: 100,
};

// ── Value coercion ──────────────────────────────────────────────────────────

export function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (v && typeof v === "object" && "bool" in (v as any)) return Boolean((v as any).bool);
  return Boolean(v);
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && "count" in (v as any)) {
    const n = Number((v as any).count);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in (v as any)) return String((v as any).value);
  return null;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the full entitlement set for one organization. Reads:
 *   1. the active subscription's PlanVersion entitlements (PLAN_DEFAULT)
 *   2. the selected volume options' entitlements (VOLUME_OPTION)
 *   3. non-expired TenantEntitlement rows (every other source)
 */
export async function resolveEntitlements(tenantId: string): Promise<EntitlementSet> {
  const entries = new Map<string, ResolvedEntitlement>();
  const now = new Date();

  const put = (key: string, valueType: EntitlementValueType, value: unknown, source: EntitlementSource) => {
    const existing = entries.get(key);
    if (existing && existing.source !== "CATALOG_DEFAULT") {
      if (SOURCE_RANK[source] < SOURCE_RANK[existing.source as EntitlementSource]) return;
    }
    entries.set(key, { key, valueType, value, source });
  };

  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId },
    include: { entity: { include: { subscription: true } } },
  });
  const sub = link?.entity.subscription ?? null;

  // 1) Plan defaults - the active subscription's exact PlanVersion. A CUSTOM
  //    plan is a PlanVersion, so negotiated terms need no special case here.
  if (sub) {
    const plan = await prisma.plan.findUnique({
      where: { key_version: { key: sub.planKey, version: sub.planVersion } },
      include: { entitlements: true, volumeOptions: true },
    });
    for (const e of plan?.entitlements ?? []) {
      put(e.entitlementKey, e.valueType, e.value, "PLAN_DEFAULT");
    }

    // 2) Volume options currently selected on the subscription. They only ever
    //    ADD recurring credits, so the entitlement they carry is the included
    //    credit allowance - never a feature flag.
    const selected = (plan?.volumeOptions ?? []).filter(
      (o) => o.key === sub.chatVolumeOptionKey || o.key === sub.voiceVolumeOptionKey,
    );
    if (selected.length) {
      const base = asNumber(entries.get("limit:included_ai_units")?.value) ?? plan?.includedAiUnits ?? 0;
      const total = selected.reduce((sum, o) => sum + o.additionalCredits, base);
      put("limit:included_ai_units", "COUNTER", { count: total }, "VOLUME_OPTION");
    }
  }

  // 3) Tenant overrides. Expired rows drop out silently.
  const overrides = await prisma.tenantEntitlement.findMany({ where: { tenantId } });
  for (const o of overrides) {
    if (o.expiresAt && o.expiresAt <= now) continue;
    put(o.entitlementKey, o.valueType, o.value, o.source);
  }

  return {
    tenantId,
    planKey: sub?.planKey ?? null,
    planVersion: sub?.planVersion ?? null,
    entries,
    unsubscribed: !sub,
  };
}

// ── Structured denial ───────────────────────────────────────────────────────

export interface EntitlementErrorBody {
  code: "PLAN_FEATURE_REQUIRED" | "PLAN_LIMIT_REACHED" | "FEATURE_NOT_AVAILABLE";
  feature: string;
  currentPlan: string | null;
  /** Present on limit errors only. */
  limit?: number;
  current?: number;
  upgradePath: string;
}

/**
 * Thrown by the assert* helpers. Carries a client-safe body - the plan key the
 * organization is on and where to go next - and deliberately NO pricing
 * configuration, no plan catalog internals and no cost data.
 */
export class EntitlementDeniedError extends Error {
  readonly status = 402;
  constructor(readonly body: EntitlementErrorBody) {
    super(`${body.code}:${body.feature}`);
    this.name = "EntitlementDeniedError";
  }
}

const UPGRADE_PATH = "/settings/billing/plan";

// ── Feature checks ──────────────────────────────────────────────────────────

/**
 * Is a BOOLEAN capability entitled?
 *
 * A capability the product has not built is always false, whatever a plan says.
 * A tenant with no subscription gets the catalog default, which keeps
 * pre-billing tenants working on the always-included core while still denying
 * the paid capabilities (`ai.employee`, `ai.copilot`, `voice.*`).
 */
export async function isEntitled(tenantId: string, featureKey: string): Promise<boolean> {
  if (isUnsellable(featureKey)) return false;
  const set = await resolveEntitlements(tenantId);
  return entitledIn(set, featureKey);
}

/** Same check against an already-resolved set (avoids a second round trip). */
export function entitledIn(set: EntitlementSet, featureKey: string): boolean {
  if (isUnsellable(featureKey)) return false;
  const entry = set.entries.get(featureKey);
  if (entry) {
    // A compliance deny is a deny, no matter what the stored value says.
    if (entry.source === "COMPLIANCE_DENY") return false;
    return asBool(entry.value);
  }
  return asBool(getFeatureDef(featureKey)?.defaultValue);
}

export async function assertEntitled(tenantId: string, featureKey: string): Promise<void> {
  if (await isEntitled(tenantId, featureKey)) return;
  const set = await resolveEntitlements(tenantId);
  throw new EntitlementDeniedError({
    code: isUnsellable(featureKey) ? "FEATURE_NOT_AVAILABLE" : "PLAN_FEATURE_REQUIRED",
    feature: featureKey,
    currentPlan: set.planKey,
    upgradePath: UPGRADE_PATH,
  });
}

// ── Numeric limits ──────────────────────────────────────────────────────────

/** Effective numeric limit. `null` = unset/unlimited; `UNLIMITED_LIMIT` = explicit unlimited. */
export async function resolveLimit(tenantId: string, limitKey: string): Promise<number | null> {
  const set = await resolveEntitlements(tenantId);
  return limitIn(set, limitKey);
}

export function limitIn(set: EntitlementSet, limitKey: string): number | null {
  const entry = set.entries.get(limitKey);
  if (entry) {
    if (entry.valueType === "UNLIMITED") return UNLIMITED_LIMIT;
    const n = asNumber(entry.value);
    if (n != null) return n;
  }
  return asNumber(getFeatureDef(limitKey)?.defaultValue);
}

/** Every COUNTER limit at once - one round trip for a settings screen. */
export async function resolveLimits(tenantId: string): Promise<Record<string, number>> {
  const set = await resolveEntitlements(tenantId);
  const out: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const v = limitIn(set, key);
    if (v != null) out[key] = v;
  }
  return out;
}

export function isUnlimited(limit: number | null): boolean {
  return limit == null || limit === UNLIMITED_LIMIT;
}

/**
 * Guard a create path: `currentCount` existing resources, about to add `adding`.
 *
 * Deliberately checks BEFORE the write and never deletes anything. A downgrade
 * that leaves an organization over its new limit keeps every existing resource
 * working and only blocks NEW creation - see `overLimitDisposition()`.
 */
export async function assertWithinLimit(
  tenantId: string,
  limitKey: string,
  currentCount: number,
  adding = 1,
): Promise<void> {
  const limit = await resolveLimit(tenantId, limitKey);
  if (isUnlimited(limit)) return;
  if (currentCount + adding <= (limit as number)) return;
  const set = await resolveEntitlements(tenantId);
  throw new EntitlementDeniedError({
    code: "PLAN_LIMIT_REACHED",
    feature: limitKey,
    currentPlan: set.planKey,
    limit: limit as number,
    current: currentCount,
    upgradePath: UPGRADE_PATH,
  });
}

// ── Downgrade safety ────────────────────────────────────────────────────────

export type LimitBreachBehavior = "BLOCK_NEW" | "READ_ONLY" | "USER_SELECT" | "GRACE_PERIOD";

/**
 * What to do when an organization already holds MORE resources than its new
 * plan allows. Never "delete the excess".
 *
 * Configurable per limit type via a CONFIG entitlement
 * (`config:limit_breach:<limitKey>`); the safe default is BLOCK_NEW, which
 * leaves everything the customer already built fully working.
 */
export async function overLimitDisposition(
  tenantId: string,
  limitKey: string,
  currentCount: number,
): Promise<{ overBy: number; behavior: LimitBreachBehavior; limit: number | null }> {
  const set = await resolveEntitlements(tenantId);
  const limit = limitIn(set, limitKey);
  const overBy = isUnlimited(limit) ? 0 : Math.max(0, currentCount - (limit as number));
  const cfg = set.entries.get(`config:limit_breach:${limitKey}`);
  const behavior = (asString(cfg?.value) as LimitBreachBehavior | null) ?? "BLOCK_NEW";
  return { overBy, behavior, limit };
}

// ── Express helper ──────────────────────────────────────────────────────────

/**
 * Render an EntitlementDeniedError as the structured 402 body. Returns null for
 * any other error so callers can rethrow.
 */
export function entitlementErrorResponse(
  err: unknown,
): { status: number; body: EntitlementErrorBody } | null {
  if (err instanceof EntitlementDeniedError) return { status: err.status, body: err.body };
  return null;
}
