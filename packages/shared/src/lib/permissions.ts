import { prisma } from "./prisma";
import {
  FEATURE_METADATA,
  isFeature,
  type Feature,
} from "./features";

/**
 * Two-layer permission resolver.
 *
 *   Tenant layer: SYSTEM_ADMIN says "tenant X is allowed feature F".
 *   User layer:   tenant ADMIN says "user U (or role R) can use feature F".
 *
 * SYSTEM_ADMIN bypasses everything.
 * ADMIN bypasses the user layer (gets every tenant-enabled feature).
 * AGENT must be granted via role assignment or per-user grant — unless the
 *   feature metadata says defaultAgentAccess: "all".
 *
 * For features that map to a legacy Boolean column on `Tenant` (e.g.
 * `botEnabled`), a missing `tenant_features` row falls back to that column,
 * keeping un-migrated call sites working.
 */

export interface PermissionUser {
  userId: string;
  tenantId: string;
  role: string; // SYSTEM_ADMIN | ADMIN | AGENT
}

/** Short-TTL in-process cache. Keyed by tenant or user; invalidated on writes. */
const TENANT_CACHE_TTL_MS = 30_000;
const USER_CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const tenantFeatureCache = new Map<string, CacheEntry<Map<string, boolean>>>();
const userGrantCache = new Map<string, CacheEntry<Map<string, boolean>>>();
const userRoleFeatureCache = new Map<string, CacheEntry<Set<string>>>();

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number): void {
  map.set(key, { value, expiresAt: Date.now() + ttl });
}

export function invalidatePermissionsCache(opts: { tenantId?: string; userId?: string } = {}): void {
  if (!opts.tenantId && !opts.userId) {
    tenantFeatureCache.clear();
    userGrantCache.clear();
    userRoleFeatureCache.clear();
    return;
  }
  if (opts.tenantId) tenantFeatureCache.delete(opts.tenantId);
  if (opts.userId) {
    userGrantCache.delete(opts.userId);
    userRoleFeatureCache.delete(opts.userId);
  }
}

/**
 * Load tenant-level enabled features. Falls back to legacy `Tenant` Boolean
 * columns when no `tenant_features` row exists for a feature with a
 * `legacyColumn` declared in metadata.
 */
async function loadTenantFeatures(tenantId: string): Promise<Map<string, boolean>> {
  const cached = getCached(tenantFeatureCache, tenantId);
  if (cached) return cached;

  const [rows, tenant] = await Promise.all([
    prisma.tenantFeature.findMany({
      where: { tenantId },
      select: { feature: true, enabled: true },
    }),
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        botEnabled: true,
        firstTakeCareEnabled: true,
        voiceCopilotEnabled: true,
        voiceInboxUiEnabled: true,
        voiceIncomingEnabled: true,
      },
    }),
  ]);

  const map = new Map<string, boolean>();
  for (const row of rows) map.set(row.feature, row.enabled);

  // Legacy fallback for features whose tenant_features row may not exist yet
  // (e.g. tenants created before backfill or features added before migration).
  if (tenant) {
    for (const meta of Object.values(FEATURE_METADATA)) {
      if (!meta.legacyColumn) continue;
      if (map.has(meta.key)) continue;
      const legacyValue = (tenant as Record<string, unknown>)[meta.legacyColumn];
      if (typeof legacyValue === "boolean") map.set(meta.key, legacyValue);
    }
  }

  setCached(tenantFeatureCache, tenantId, map, TENANT_CACHE_TTL_MS);
  return map;
}

async function loadUserGrants(userId: string): Promise<Map<string, boolean>> {
  const cached = getCached(userGrantCache, userId);
  if (cached) return cached;

  const grants = await prisma.userFeatureGrant.findMany({
    where: { userId },
    select: { feature: true, granted: true },
  });
  const map = new Map<string, boolean>();
  for (const g of grants) map.set(g.feature, g.granted);
  setCached(userGrantCache, userId, map, USER_CACHE_TTL_MS);
  return map;
}

async function loadUserRoleFeatures(userId: string): Promise<Set<string>> {
  const cached = getCached(userRoleFeatureCache, userId);
  if (cached) return cached;

  const assignments = await prisma.userRoleAssignment.findMany({
    where: { userId },
    select: {
      role: {
        select: { features: { select: { feature: true } } },
      },
    },
  });
  const set = new Set<string>();
  for (const a of assignments) {
    for (const f of a.role.features) set.add(f.feature);
  }
  setCached(userRoleFeatureCache, userId, set, USER_CACHE_TTL_MS);
  return set;
}

/** Does this tenant have feature F enabled at the org level? */
export async function isFeatureEnabledForTenant(
  tenantId: string,
  feature: Feature,
): Promise<boolean> {
  const map = await loadTenantFeatures(tenantId);
  if (map.has(feature)) return map.get(feature)!;
  // Unknown to DB and no legacy column → use metadata default.
  return FEATURE_METADATA[feature]?.defaultEnabled ?? false;
}

/** Does this user have access to feature F right now, given tenant + role + grants? */
export async function hasFeature(user: PermissionUser, feature: Feature): Promise<boolean> {
  if (!isFeature(feature)) return false;

  // 1. SYSTEM_ADMIN — total bypass.
  if (user.role === "SYSTEM_ADMIN") return true;

  // 2. Tenant must have it enabled.
  const tenantEnabled = await isFeatureEnabledForTenant(user.tenantId, feature);
  if (!tenantEnabled) return false;

  // 3. Explicit user-level override wins over everything role-derived.
  const grants = await loadUserGrants(user.userId);
  if (grants.has(feature)) return grants.get(feature)!;

  // 4. ADMIN gets every tenant-enabled feature by default.
  if (user.role === "ADMIN") return true;

  // 5. AGENT: union of role grants ∪ metadata default.
  const meta = FEATURE_METADATA[feature];
  if (meta.defaultAgentAccess === "all") return true;
  const roleFeatures = await loadUserRoleFeatures(user.userId);
  return roleFeatures.has(feature);
}

/** All features the user can currently access (after full resolution). */
export async function getUserFeatures(user: PermissionUser): Promise<Feature[]> {
  const allowed: Feature[] = [];
  for (const feature of Object.values(FEATURE_METADATA).map((m) => m.key)) {
    if (await hasFeature(user, feature)) allowed.push(feature);
  }
  return allowed;
}

/** All features the tenant has enabled (without considering any specific user). */
export async function getTenantFeatures(tenantId: string): Promise<Feature[]> {
  const map = await loadTenantFeatures(tenantId);
  const result: Feature[] = [];
  for (const [key, enabled] of map.entries()) {
    if (enabled && isFeature(key)) result.push(key as Feature);
  }
  return result;
}

/** Throws a structured error if the gate fails. Convenience for service code. */
export class FeatureGateError extends Error {
  readonly code = "FEATURE_NOT_AVAILABLE";
  constructor(public readonly feature: Feature, public readonly reason: "tenant" | "user") {
    super(`Feature '${feature}' not available (${reason}-level)`);
  }
}

export async function assertFeature(user: PermissionUser, feature: Feature): Promise<void> {
  if (user.role === "SYSTEM_ADMIN") return;
  const tenantOk = await isFeatureEnabledForTenant(user.tenantId, feature);
  if (!tenantOk) throw new FeatureGateError(feature, "tenant");
  const ok = await hasFeature(user, feature);
  if (!ok) throw new FeatureGateError(feature, "user");
}
