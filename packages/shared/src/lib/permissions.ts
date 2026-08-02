import { prisma } from "./prisma";
import {
  FEATURE_METADATA,
  isFeature,
  type Feature,
} from "./features";
import {
  ALL_PERMISSION_KEYS,
  BUILTIN_ROLES,
  builtinRoleForLegacy,
  expandPermissionPatterns,
  isPermissionKey,
  licenseKeysFor,
  ALL_LICENSE_KEYS,
  maxScope,
  type PermissionScope,
} from "./permission-catalog";

/**
 * Two-layer permission resolver.
 *
 *   Tenant layer: SYSTEM_ADMIN says "tenant X is allowed feature F".
 *   User layer:   tenant ADMIN says "user U (or role R) can use feature F".
 *
 * SYSTEM_ADMIN bypasses everything.
 * ADMIN bypasses the user layer (gets every tenant-enabled feature).
 * AGENT must be granted via role assignment or per-user grant - unless the
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

// New hierarchical-permission caches (permission-catalog driven).
const tenantLicenseCache = new Map<string, CacheEntry<Map<string, boolean>>>();
const userPermissionCache = new Map<string, CacheEntry<Set<string>>>();
const userScopeCache = new Map<string, CacheEntry<PermissionScope>>();

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
    tenantLicenseCache.clear();
    userPermissionCache.clear();
    userScopeCache.clear();
    userBuiltinRoleCache.clear();
    return;
  }
  if (opts.tenantId) {
    tenantFeatureCache.delete(opts.tenantId);
    tenantLicenseCache.delete(opts.tenantId);
  }
  if (opts.userId) {
    userGrantCache.delete(opts.userId);
    userRoleFeatureCache.delete(opts.userId);
    userPermissionCache.delete(opts.userId);
    userScopeCache.delete(opts.userId);
    userBuiltinRoleCache.delete(opts.userId);
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
    where: {
      userId,
      // The role must belong to the SAME tenant this user is a member of.
      // Without it, an assignment pointing at another organization's role row
      // was read and honoured: the dev estate had exactly that - urban's owner
      // wired to demo-company's Owner. It resolved to identical permissions
      // only because both were seeded from one catalog, so nothing looked
      // wrong; editing or deleting the other tenant's role would have silently
      // changed or removed this user's access. A User belongs to exactly one
      // tenant, so this reads as "the role's tenant is my tenant".
      role: { tenant: { users: { some: { id: userId } } } },
    },
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

  // 1. SYSTEM_ADMIN - total bypass.
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

// ═════════════════════════════════════════════════════════════
// Hierarchical permission resolver (permission-catalog driven).
//
// This is the canonical RBAC path. Everything flows through here; there are
// NO hardcoded tenant-role checks. The only role string consulted directly is
// SYSTEM_ADMIN - the PLATFORM super-admin tier (not a tenant role).
//
// Effective answer for hasPermission(user, key):
//   SYSTEM_ADMIN                       → allow (platform bypass)
//   tenant not licensed for the key    → deny           (License layer)
//   explicit user grant/revoke         → that value     (Additional layer)
//   key ∈ union(role permission sets)  → allow          (Role layer)
//   else                               → deny
//
// `License AND Permission` falls out of steps 2 + 3/4. Packaging (plans.ts)
// only writes the tenant License layer; it shares this exact resolver.
// ═════════════════════════════════════════════════════════════

/** Caller identity for a permission decision. */
export interface PermissionPrincipal {
  userId: string;
  tenantId: string;
  role: string; // SYSTEM_ADMIN | ADMIN | AGENT  (legacy enum - bridge only)
  /** Legacy department role (AGENT | MANAGER) - used only by the migration bridge. */
  departmentRole?: string | null;
}

const DB_TO_SCOPE: Record<string, PermissionScope> = {
  OWN: "own",
  TEAM: "team",
  DEPARTMENT: "department",
  WORKSPACE: "workspace",
};

/** Catalog scope ("own") → DB enum value ("OWN"). For writes/seeds. */
export function scopeToDb(scope: PermissionScope): "OWN" | "TEAM" | "DEPARTMENT" | "WORKSPACE" {
  return scope.toUpperCase() as "OWN" | "TEAM" | "DEPARTMENT" | "WORKSPACE";
}

/**
 * Tenant license map: explicit entitlement rows keyed by catalog license keys
 * (feature or feature:sub-feature). Default-ALLOW - a permission is licensed
 * unless an applicable key is explicitly disabled. This keeps every existing
 * tenant fully enabled until packaging (P3) writes a plan's license map.
 */
async function loadTenantLicense(tenantId: string): Promise<Map<string, boolean>> {
  const cached = getCached(tenantLicenseCache, tenantId);
  if (cached) return cached;

  const rows = await prisma.tenantFeature.findMany({
    where: { tenantId },
    select: { feature: true, enabled: true },
  });
  const licenseKeys = new Set(ALL_LICENSE_KEYS);
  const map = new Map<string, boolean>();
  for (const row of rows) {
    if (licenseKeys.has(row.feature)) map.set(row.feature, row.enabled);
  }
  setCached(tenantLicenseCache, tenantId, map, TENANT_CACHE_TTL_MS);
  return map;
}

/** Is the tenant licensed (by plan/package) for this permission's feature? */
export async function isPermissionLicensed(tenantId: string, permissionKey: string): Promise<boolean> {
  const map = await loadTenantLicense(tenantId);
  // Most specific entitlement key wins: feature:sub-feature, then feature.
  for (const lk of licenseKeysFor(permissionKey)) {
    if (map.has(lk)) return map.get(lk)!;
  }
  return true; // no explicit entitlement → allowed (packaging not enabled)
}

interface RoleResolution {
  patterns: string[];
  scope: PermissionScope;
}

/** Load this user's role-derived permission patterns + effective scope. */
async function loadUserRoleResolution(user: PermissionPrincipal): Promise<RoleResolution> {
  const assignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId: user.userId,
      // The role must belong to the SAME tenant this user is a member of.
      // Without it, an assignment pointing at another organization's role row
      // was read and honoured: the dev estate had exactly that - urban's owner
      // wired to demo-company's Owner. It resolved to identical permissions
      // only because both were seeded from one catalog, so nothing looked
      // wrong; editing or deleting the other tenant's role would have silently
      // changed or removed this user's access. A User belongs to exactly one
      // tenant, so this reads as "the role's tenant is my tenant".
      role: { tenant: { users: { some: { id: user.userId } } } },
    },
    select: {
      scope: true,
      role: {
        select: {
          defaultScope: true,
          features: { select: { feature: true } },
        },
      },
    },
  });

  if (assignments.length > 0) {
    const patterns: string[] = [];
    let scope: PermissionScope = "own";
    for (const a of assignments) {
      for (const f of a.role.features) patterns.push(f.feature);
      const effective = a.scope
        ? DB_TO_SCOPE[a.scope]
        : DB_TO_SCOPE[a.role.defaultScope] ?? "own";
      scope = maxScope(scope, effective);
    }
    return { patterns, scope };
  }

  // Migration bridge: no explicit assignment yet → derive the built-in role
  // from the legacy enum. Permissions still come from the role's catalog
  // definition; this maps an identity to a role, it is not an authz decision.
  const bk = builtinRoleForLegacy(user.role, user.departmentRole);
  if (!bk) return { patterns: [], scope: "own" };
  const def = BUILTIN_ROLES[bk];
  return { patterns: def.permissions, scope: def.defaultScope };
}

/** Expanded set of permission keys granted by the user's role(s). */
async function loadUserPermissionSet(user: PermissionPrincipal): Promise<Set<string>> {
  const cached = getCached(userPermissionCache, user.userId);
  if (cached) return cached;
  const { patterns } = await loadUserRoleResolution(user);
  const set = expandPermissionPatterns(patterns);
  setCached(userPermissionCache, user.userId, set, USER_CACHE_TTL_MS);
  return set;
}

/** Does this user hold permission `key` right now (License AND Role/Grant)? */
export async function hasPermission(user: PermissionPrincipal, key: string): Promise<boolean> {
  if (!isPermissionKey(key)) return false;
  // Platform super-admin tier (not a tenant role).
  if (user.role === "SYSTEM_ADMIN") return true;

  // License layer.
  if (!(await isPermissionLicensed(user.tenantId, key))) return false;

  // Explicit per-user grant/revoke wins over role-derived permissions.
  const grants = await loadUserGrants(user.userId);
  if (grants.has(key)) return grants.get(key)!;

  // Role layer.
  const rolePerms = await loadUserPermissionSet(user);
  return rolePerms.has(key);
}

const userBuiltinRoleCache = new Map<string, CacheEntry<string | null>>();

/**
 * The user's effective built-in role key (owner|admin|department_manager|agent)
 * from their assignment, falling back to the legacy enum bridge when no
 * assignment exists. Used by the requireRole bridge so assigned roles govern
 * access across every service. Returns null for unknown.
 */
export async function getEffectiveBuiltinRole(user: PermissionPrincipal): Promise<string | null> {
  if (user.role === "SYSTEM_ADMIN") return null; // handled by platform bypass upstream
  const cached = getCached(userBuiltinRoleCache, user.userId);
  if (cached !== undefined) return cached;

  const assignment = await prisma.userRoleAssignment.findFirst({
    where: {
      userId: user.userId,
      // The role must belong to the SAME tenant this user is a member of.
      // Without it, an assignment pointing at another organization's role row
      // was read and honoured: the dev estate had exactly that - urban's owner
      // wired to demo-company's Owner. It resolved to identical permissions
      // only because both were seeded from one catalog, so nothing looked
      // wrong; editing or deleting the other tenant's role would have silently
      // changed or removed this user's access. A User belongs to exactly one
      // tenant, so this reads as "the role's tenant is my tenant".
      role: { tenant: { users: { some: { id: user.userId } } } },
    },
    select: { role: { select: { builtinKey: true } } },
    orderBy: { assignedAt: "desc" },
  });
  const value =
    assignment?.role.builtinKey ?? builtinRoleForLegacy(user.role, user.departmentRole);
  setCached(userBuiltinRoleCache, user.userId, value, USER_CACHE_TTL_MS);
  return value;
}

/** Effective data-reach scope for this user (max over assigned roles). */
export async function resolveUserScope(user: PermissionPrincipal): Promise<PermissionScope> {
  if (user.role === "SYSTEM_ADMIN") return "workspace";
  const cached = getCached(userScopeCache, user.userId);
  if (cached) return cached;
  const { scope } = await loadUserRoleResolution(user);
  setCached(userScopeCache, user.userId, scope, USER_CACHE_TTL_MS);
  return scope;
}

/** Every permission key the user can currently exercise (after License + grants). */
export async function getUserPermissions(user: PermissionPrincipal): Promise<string[]> {
  if (user.role === "SYSTEM_ADMIN") return [...ALL_PERMISSION_KEYS];

  const rolePerms = await loadUserPermissionSet(user);
  const effective = new Set(rolePerms);
  const grants = await loadUserGrants(user.userId);
  for (const [k, granted] of grants.entries()) {
    if (!isPermissionKey(k)) continue;
    if (granted) effective.add(k);
    else effective.delete(k);
  }
  const license = await loadTenantLicense(user.tenantId);
  const licenseKeySet = new Set(ALL_LICENSE_KEYS);
  const isLicensed = (key: string): boolean => {
    for (const lk of licenseKeysFor(key)) {
      if (licenseKeySet.has(lk) && license.has(lk)) return license.get(lk)!;
    }
    return true;
  };
  return [...effective].filter(isLicensed);
}

/** Full effective view for the current user - feeds /api/permissions/me. */
export async function getEffectiveAccess(user: PermissionPrincipal): Promise<{
  permissions: string[];
  scope: PermissionScope;
}> {
  const [permissions, scope] = await Promise.all([
    getUserPermissions(user),
    resolveUserScope(user),
  ]);
  return { permissions, scope };
}

/** Structured error mirror of FeatureGateError, for the permission layer. */
export class PermissionDeniedError extends Error {
  readonly code = "PERMISSION_DENIED";
  constructor(public readonly permission: string) {
    super(`Permission '${permission}' denied`);
  }
}

export async function assertPermission(user: PermissionPrincipal, key: string): Promise<void> {
  if (!(await hasPermission(user, key))) throw new PermissionDeniedError(key);
}
