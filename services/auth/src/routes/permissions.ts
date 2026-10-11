import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  prisma,
  authenticate,
  requireRole,
  resolveTenant,
  validate,
  assertTenantId,
  writeAudit,
  AuditAction,
  invalidatePermissionsCache,
  getUserFeatures,
  getEffectiveAccess,
  getEffectiveBuiltinRole,
  ALL_FEATURES,
  FEATURE_METADATA,
  isFeature,
  type Feature,
  // Hierarchical permission catalog (single source of truth).
  PERMISSIONS,
  BUILTIN_ROLES,
  BUILTIN_ROLE_ORDER,
  ROLE_CEILINGS,
  OWNER_FLOOR,
  ceilingKeysFor,
  rolesEditable,
  customizedRoleKey,
  expandPermissionPatterns,
  SCOPE_ORDER,
  isPermissionKey,
  expandPermissionPattern,
  listPermissionsByDomain,
  getLastLoginBySubject,
} from "@chatcenter/shared";
import { changeRoles, RoleChangeRefused } from "../services/role-guard";
import { actorOf, patternsRefusal, roleRefusal, targetRefusal, type GrantRefusal } from "../lib/grant-ceiling";

/** Answer a refusal from lib/grant-ceiling; true when the request is done. */
function refusedGrant(res: Response, refusal: GrantRefusal | null): boolean {
  if (!refusal) return false;
  res.status(refusal.status).json({ error: refusal.error, code: refusal.code, ...(refusal.missing ? { missing: refusal.missing } : {}) });
  return true;
}
import { readerLocale } from "../lib/reader-locale";
import { permissionFor, roleFor } from "../lib/permission-catalog-he";

/** A refused role change says why (409), so the screen can explain it. */
function refused(res: Response, err: unknown): boolean {
  if (!(err instanceof RoleChangeRefused)) return false;
  res.status(409).json({ error: err.message, code: err.code });
  return true;
}

/**
 * A grantable key may be either a legacy feature key OR a hierarchical
 * permission key / wildcard pattern. Both live in the same string columns;
 * the resolver knows which namespace each belongs to.
 */
function isGrantableKey(key: string): boolean {
  if (key === "*") return true;
  if (key.endsWith(":*")) return expandPermissionPattern(key).length > 0;
  return isFeature(key) || isPermissionKey(key);
}

/**
 * Tenant ADMIN - permission configuration within the tenant.
 *
 * Routes:
 *   GET    /api/permissions/me                     features the caller can access
 *   GET    /api/permissions/users/:userId          resolved features for one user
 *   GET    /api/permissions/users/:userId/grants   raw per-user overrides
 *   PUT    /api/permissions/users/:userId/grants/:feature  grant/revoke override
 *   DELETE /api/permissions/users/:userId/grants/:feature  remove override
 *
 *   GET    /api/permissions/roles                  list custom tenant roles
 *   POST   /api/permissions/roles                  create custom role
 *   PATCH  /api/permissions/roles/:roleId          rename/update role
 *   DELETE /api/permissions/roles/:roleId          delete (non-system) role
 *   PUT    /api/permissions/roles/:roleId/features replace role's feature set
 *
 *   POST   /api/permissions/users/:userId/roles/:roleId  assign role to user
 *   DELETE /api/permissions/users/:userId/roles/:roleId  unassign role
 *
 * All writes require ADMIN role and are tenant-scoped via assertTenantId().
 */

const router = Router();

const ADMIN_ONLY = [authenticate, resolveTenant, requireRole("ADMIN")];
const ANY_USER = [authenticate, resolveTenant];

async function ensureUserBelongsToTenant(userId: string, tenantId: string): Promise<boolean> {
  const u = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true },
  });
  return !!u;
}

async function ensureRoleBelongsToTenant(roleId: string, tenantId: string) {
  return prisma.tenantRole.findFirst({ where: { id: roleId, tenantId } });
}

// ─── Self: what can I access right now? ────────────────────────
// Returns the canonical hierarchical permission set + effective scope (the
// new RBAC surface the frontend reacts to) AND the legacy feature list
// (kept for back-compat with existing callers).
router.get("/me", ...ANY_USER, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const principal = {
    userId: req.user!.userId,
    tenantId,
    role: req.user!.role,
    departmentRole: req.user!.departmentRole,
  };
  const [features, access, roleKey] = await Promise.all([
    getUserFeatures({ userId: principal.userId, tenantId, role: principal.role }),
    getEffectiveAccess(principal),
    getEffectiveBuiltinRole(principal),
  ]);
  res.json({
    data: {
      role: req.user!.role, // legacy enum
      roleKey: req.user!.role === "SYSTEM_ADMIN" ? "system_admin" : roleKey, // effective built-in role
      permissions: access.permissions,
      scope: access.scope,
      features, // legacy
    },
  });
});

// ─── Members: ALL tenant users + their assigned role + scope ────
// The unified User Management list. Unlike /api/agents (agent-only), this
// returns every member with the new built-in role assignment.
router.get("/users", ...ADMIN_ONLY, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const users = await prisma.user.findMany({
    where: { tenantId, role: { not: "SYSTEM_ADMIN" } },
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      phoneNumber: true,
      role: true, // legacy enum (fallback)
      departmentMembers: {
        select: { departmentId: true, departmentRole: true, department: { select: { name: true } } },
        orderBy: { createdAt: "asc" as const },
      },
      roleAssignments: {
        select: { scope: true, role: { select: { id: true, name: true, builtinKey: true, defaultScope: true } } },
      },
      // `conversations` is @relation("AssignedAgent"), so this is conversations
      // ASSIGNED TO this person - not authored or participated in. The
      // AI-employee count on /api/ai-agents is also an assignment count and
      // the two are rendered in one column.
      //
      // NOT THE SAME PREDICATE ANY MORE, and this comment used to claim it was.
      // D54 narrowed the AI side to exclude the owner's sandbox test chat and
      // `isTest` rehearsal conversations. Of those two, only `isTest` can reach
      // THIS count - a sandbox row sets assignedAiAgentId and never
      // assignedAgentId - so a person's total still includes setup rehearsal
      // and an employee's no longer does.
      //
      // Imported history is a separate question and this count is NOT covered
      // by the platform's guard: `applyLiveByDefault` keys on the TOP-LEVEL
      // model, which here is User, so it never reaches a nested `_count` on
      // conversations. Whether that matters depends on an imported conversation
      // never carrying an assignee, which the schema states and which no row on
      // this database can currently confirm or refute.
      //
      // Left as-is deliberately rather than quietly narrowed: changing what a
      // roster number counts is a product decision, not a comment fix.
      _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } },
    },
  });
  const data = users.map((u) => {
    const assignment = u.roleAssignments[0] ?? null;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      isActive: u.isActive,
      phoneNumber: u.phoneNumber,
      legacyRole: u.role,
      // Singular fields = the primary (earliest) membership, kept for legacy
      // consumers; `departments` carries the FULL list so multi-department
      // members render every department, not just the first.
      departmentId: u.departmentMembers?.[0]?.departmentId ?? null,
      departmentRole: u.departmentMembers?.[0]?.departmentRole ?? null,
      departmentName: u.departmentMembers?.[0]?.department?.name ?? null,
      departments: u.departmentMembers.map((m) => ({
        departmentId: m.departmentId,
        departmentRole: m.departmentRole,
        departmentName: m.department?.name ?? null,
      })),
      roleId: assignment?.role.id ?? null,
      roleName: assignment?.role.name ?? null,
      roleBuiltinKey: assignment?.role.builtinKey ?? null,
      scope: assignment?.scope ?? assignment?.role.defaultScope ?? null,
      // OPEN + WAITING, i.e. "not finished". WAITING is usually awaiting the
      // customer, so this is not a count of what the person is handling right
      // now and must not be captioned as live activity.
      openConversations: u._count.conversations,
    };
  });
  res.json({ data });
});

// ─── Members: login / invite state ─────────────────────────────
//
// MUST stay above `/users/:userId` or that route captures "login-status" as a
// user id and answers 404 for a path that exists.
//
// A SIBLING of /users rather than fields on it, and that is not a style
// choice: the status comes from getLastLoginBySubject, which is one Authentik
// round-trip PER USER. On the roster every row would wait on N network calls
// before the table could paint, and an unreachable Authentik would take the
// whole list down instead of costing one badge. Split, the table renders
// immediately and this degrades on its own.
//
// The state is DERIVED, not recorded. `/api/agents` (the Settings invite path)
// creates an Authentik identity and returns a setup link without writing any
// invite row - only the ONBOARDING invite flow writes TenantInvite. So
// "invited" here means an active member who has never logged in, inferred.
// Nothing tracks that an invite was sent, by whom, or when it expires.
router.get("/users/login-status", ...ADMIN_ONLY, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  // Same member set as GET /users, so the two line up row for row.
  const users = await prisma.user.findMany({
    where: { tenantId, role: { not: "SYSTEM_ADMIN" } },
    select: { id: true, isActive: true, identity: { select: { authentikSubject: true } } },
  });
  const entries = await Promise.all(users.map(async (u) => {
    let lastLogin: string | null = null;
    if (u.identity?.authentikSubject) {
      // Best-effort: one member's unreachable record must not fail the list.
      try { lastLogin = await getLastLoginBySubject(u.identity.authentikSubject); } catch { /* best-effort */ }
    }
    const status = !u.isActive ? "disabled" : lastLogin ? "active" : "invited";
    return [u.id, { status, lastLogin }] as const;
  }));
  res.json({ data: Object.fromEntries(entries) });
});

// ─── User: resolved feature set ────────────────────────────────
router.get("/users/:userId", ...ADMIN_ONLY, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const userId = req.params.userId as string;
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: {
      id: true,
      role: true,
      email: true,
      name: true,
      roleAssignments: { select: { roleId: true, scope: true } },
      featureGrants: { select: { feature: true, granted: true, reason: true, expiresAt: true } },
    },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const [features, access] = await Promise.all([
    getUserFeatures({ userId: user.id, tenantId, role: user.role }),
    getEffectiveAccess({
      userId: user.id,
      tenantId,
      role: user.role,
      departmentRole: null,
    }),
  ]);
  res.json({
    data: {
      user: { id: user.id, role: user.role, email: user.email, name: user.name },
      roles: user.roleAssignments,
      grants: user.featureGrants.map((g) => withActive(g)),
      permissions: access.permissions,
      scope: access.scope,
      features, // legacy
    },
  });
});

// ─── User grants (raw overrides) ───────────────────────────────
router.get("/users/:userId/grants", ...ADMIN_ONLY, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const userId = req.params.userId as string;
  if (!(await ensureUserBelongsToTenant(userId, tenantId))) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const grants = await prisma.userFeatureGrant.findMany({ where: { userId } });
  // `active: false` = expired. Kept in the list rather than hidden so the
  // screen can say "ended on 12 Oct" - the resolver already ignores it.
  res.json({ data: grants.map((g) => withActive(g)) });
});

const upsertGrantSchema = z.object({
  granted: z.boolean(),
  reason: z.string().max(500).optional(),
  // When the override stops applying. Absent or null = no end date. The PUT
  // replaces the whole override, so re-saving without it CLEARS an end date -
  // the screen's "No end date" option is exactly that.
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

/** The grant as the screen reads it: the row plus whether it applies right now. */
function withActive<T extends { expiresAt: Date | null }>(g: T, now = Date.now()) {
  return { ...g, active: g.expiresAt === null || g.expiresAt.getTime() > now };
}

router.put(
  "/users/:userId/grants/:feature",
  ...ADMIN_ONLY,
  validate(upsertGrantSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const userId = req.params.userId as string;
    const feature = req.params.feature as string;
    if (!isGrantableKey(feature)) {
      res.status(400).json({ error: "Unknown feature or permission", feature });
      return;
    }
    if (!(await ensureUserBelongsToTenant(userId, tenantId))) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { granted, reason } = req.body as { granted: boolean; reason?: string };
    // Nobody grants what they do not hold, and an Owner's access is changed
    // by an Owner only (lib/grant-ceiling).
    if (refusedGrant(res, await targetRefusal(actorOf(req), tenantId, userId))) return;
    if (granted && refusedGrant(res, await patternsRefusal(actorOf(req), [feature]))) return;
    const rawExpiry = (req.body as { expiresAt?: string | null }).expiresAt ?? null;
    const expiresAt = rawExpiry === null ? null : new Date(rawExpiry);
    // A date already in the past would store an override that never applied -
    // a save that "worked" and did nothing. Refused instead.
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      res.status(422).json({ error: "expiresAt must be in the future", code: "EXPIRES_IN_PAST" });
      return;
    }
    const _auditTenantId = assertTenantId(req);
    const row = await prisma.userFeatureGrant.upsert({
      where: { userId_feature: { userId, feature: feature as Feature } },
      create: { userId, feature, granted, reason, expiresAt, updatedBy: req.user?.userId },
      update: { granted, reason, expiresAt, updatedBy: req.user?.userId },
    });
    invalidatePermissionsCache({ userId });
    // Expiry itself writes no audit record: it is enforced at read time and
    // nothing runs when it passes. The end date is recorded HERE, so the trail
    // says when the access was set to end.
    void writeAudit({ tenantId: _auditTenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.FEATURE_GRANT_CHANGED, targetType: "user", targetId: userId,
      metadata: { feature, granted, expiresAt: expiresAt ? expiresAt.toISOString() : null } });
    res.json({ data: withActive(row) });
  },
);

router.delete(
  "/users/:userId/grants/:feature",
  ...ADMIN_ONLY,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const userId = req.params.userId as string;
    const feature = req.params.feature as string;
    if (!(await ensureUserBelongsToTenant(userId, tenantId))) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (refusedGrant(res, await targetRefusal(actorOf(req), tenantId, userId))) return;
    await prisma.userFeatureGrant.deleteMany({ where: { userId, feature } });
    void writeAudit({ tenantId: assertTenantId(req), actorType: "user", actorId: req.user?.userId,
      action: AuditAction.PERMISSION_REVOKED, targetType: "user", targetId: userId, metadata: { feature } });
    invalidatePermissionsCache({ userId });
    res.status(204).end();
  },
);

// ─── Custom tenant roles ───────────────────────────────────────
/*
 * EDITABLE BUILT-INS WITH CEILINGS (Omer, 2026-10-11). A built-in role's set
 * can be edited (unless ROLES_EDITABLE=false), never to include a key its
 * ceiling forbids (permission-catalog ROLE_CEILINGS), and the Owner role never
 * below OWNER_FLOOR. An edited built-in is marked customized so the startup
 * seed leaves it alone; "reset" restores the catalog defaults. "admin" was
 * merged into "owner" and is not offered any more.
 */
type BuiltinKey = keyof typeof ROLE_CEILINGS;
const isBuiltinKey = (k: unknown): k is BuiltinKey => typeof k === "string" && k in ROLE_CEILINGS;

/** What the roles screen needs to draw one role, including what it may never hold. */
function roleView(role: any, customized: Set<string>) {
  const key = isBuiltinKey(role.builtinKey) ? role.builtinKey : null;
  return {
    ...role,
    editable: key === "admin" ? false : !role.isSystem || rolesEditable(),
    customized: customized.has(role.id),
    // Built-ins only: a custom role is capped by its HOLDER's built-in role at
    // read time (a person with only custom roles is capped like an Agent).
    ceiling: key ? [...ceilingKeysFor(key)].sort() : [],
    floor: key === "owner" ? [...OWNER_FLOOR] : [],
    defaults: key ? BUILTIN_ROLES[key as BuiltinKey].permissions : null,
  };
}

router.get("/roles", ...ADMIN_ONLY, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const [roles, markers] = await Promise.all([
    prisma.tenantRole.findMany({
      where: { tenantId },
      include: { features: true, _count: { select: { assignments: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.tenantSetting.findMany({ where: { tenantId, key: { startsWith: "rbac:customized:" } }, select: { key: true } }),
  ]);
  const customized = new Set(markers.map((m) => m.key.slice("rbac:customized:".length)));
  // The merged Admin role is shown only while someone still holds it.
  const visible = roles.filter((r: any) => r.builtinKey !== "admin" || r._count.assignments > 0);
  res.json({ data: visible.map((r) => roleView(r, customized)) });
});

const createRoleSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  features: z.array(z.string()).default([]),
});

router.post(
  "/roles",
  ...ADMIN_ONLY,
  validate(createRoleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const { name, description, features } = req.body as z.infer<typeof createRoleSchema>;

    const unknown = features.filter((f) => !isGrantableKey(f));
    if (unknown.length) {
      res.status(400).json({ error: "Unknown features", features: unknown });
      return;
    }
    // A custom role holding "*" (or anything its creator lacks) was a way for
    // an admin to hand out Owner-only power (lib/grant-ceiling).
    if (refusedGrant(res, await patternsRefusal(actorOf(req), features))) return;

    try {
      const role = await prisma.tenantRole.create({
        data: {
          tenantId,
          name,
          description,
          features: { create: features.map((feature) => ({ feature })) },
        },
        include: { features: true },
      });
      void writeAudit({ tenantId, actorType: "user", actorId: req.user?.userId,
        action: AuditAction.ROLE_CREATED, targetType: "role", targetId: role.id, metadata: { name: role.name } });
      res.status(201).json({ data: role });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        res.status(409).json({ error: "Role with this name already exists", code: "ROLE_NAME_TAKEN" });
        return;
      }
      throw err;
    }
  },
);

const updateRoleSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
});

router.patch(
  "/roles/:roleId",
  ...ADMIN_ONLY,
  validate(updateRoleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const roleId = req.params.roleId as string;
    const role = await ensureRoleBelongsToTenant(roleId, tenantId);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    if (role.isSystem) {
      res.status(403).json({ error: "System roles cannot be modified", code: "SYSTEM_ROLE" });
      return;
    }
    // Explicit allowlist (updateRoleSchema fields). isSystem, tenantId, and
    // feature grants are never settable via this body.
    const { name, description } = req.body as { name?: string; description?: string | null };
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    let updated;
    try {
      updated = await prisma.tenantRole.update({ where: { id: roleId }, data });
    } catch (err: unknown) {
      // A name another role of the workspace already has (unique per tenant): it was a 500.
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        res.status(409).json({ error: "Role with this name already exists", code: "ROLE_NAME_TAKEN" });
        return;
      }
      throw err;
    }
    void writeAudit({ tenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_UPDATED, targetType: "role", targetId: roleId, metadata: { fields: Object.keys(data) } });
    res.json({ data: updated });
  },
);

router.delete(
  "/roles/:roleId",
  ...ADMIN_ONLY,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const roleId = req.params.roleId as string;
    const role = await ensureRoleBelongsToTenant(roleId, tenantId);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    if (role.isSystem) {
      res.status(403).json({ error: "System roles cannot be deleted", code: "SYSTEM_ROLE" });
      return;
    }
    // Counted BEFORE the delete, and the delete is NOT blocked by it.
    //
    // A pending invitation stores its role as a plain string with no foreign
    // key, so deleting the role leaves the invite pointing at an id that
    // resolves to nothing - and the invitee will join as an agent instead.
    // Refusing the delete was the other option and it recreates a trap this
    // codebase already learned: blocking a delete on a referencing row made
    // onboarding-created employees permanently undeletable.
    //
    // So the admin is TOLD rather than stopped. They are the only person who
    // can act on this, and they are here now; the invitee, a week later, is
    // neither. The count is returned so the screen can say how many people are
    // affected - what it says is Omer's to design.
    const pendingInvites = await prisma.tenantInvite.count({
      where: { tenantId, role: roleId, acceptedAt: null, expiresAt: { gt: new Date() } },
    });

    await prisma.tenantRole.delete({ where: { id: roleId } });
    void writeAudit({ tenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_DELETED, targetType: "role", targetId: roleId,
      metadata: { pendingInvitesAffected: pendingInvites } });
    // Cascade deletes assignments + role_features; invalidate user caches broadly.
    invalidatePermissionsCache();
    // 200 rather than 204 - a body that says what else this touched is worth
    // more than the tidier status code.
    res.status(200).json({ data: { deleted: true, pendingInvitesAffected: pendingInvites } });
  },
);

const replaceFeaturesSchema = z.object({
  features: z.array(z.string()),
});

router.put(
  "/roles/:roleId/features",
  ...ADMIN_ONLY,
  validate(replaceFeaturesSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const roleId = req.params.roleId as string;
    const role = await ensureRoleBelongsToTenant(roleId, tenantId);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    // A built-in role is editable (2026-10-11) unless the kill switch is set;
    // the merged Admin role is not.
    const builtin = isBuiltinKey((role as any).builtinKey) ? ((role as any).builtinKey as BuiltinKey) : null;
    if (role.isSystem && !rolesEditable()) {
      res.status(403).json({ error: "System roles cannot be modified", code: "SYSTEM_ROLE" });
      return;
    }
    if (builtin === "admin") {
      res.status(409).json({ error: "Admin is now part of Owner", code: "ROLE_MERGED" });
      return;
    }
    const { features } = req.body as { features: string[] };
    if (builtin) {
      const expanded = expandPermissionPatterns(features);
      const blocked = [...ceilingKeysFor(builtin)].filter((k) => expanded.has(k)).sort();
      if (blocked.length) {
        res.status(403).json({ error: "This role can never hold these permissions", code: "ROLE_CEILING", blocked });
        return;
      }
      const missing = builtin === "owner" ? OWNER_FLOOR.filter((k) => !expanded.has(k)) : [];
      if (missing.length) {
        res.status(422).json({ error: "The Owner role always keeps these permissions", code: "OWNER_FLOOR", missing });
        return;
      }
    }
    const unknown = features.filter((f) => !isGrantableKey(f));
    if (unknown.length) {
      res.status(400).json({ error: "Unknown features", features: unknown });
      return;
    }
    if (refusedGrant(res, await patternsRefusal(actorOf(req), features))) return;
    // The before image, so the audit record can say exactly what changed and
    // the change can be put back.
    const before = (await prisma.tenantRoleFeature.findMany({ where: { roleId }, select: { feature: true } })).map((f) => f.feature).sort();

    await prisma.$transaction([
      prisma.tenantRoleFeature.deleteMany({ where: { roleId } }),
      prisma.tenantRoleFeature.createMany({
        data: features.map((feature) => ({ roleId, feature })),
        skipDuplicates: true,
      }),
    ]);
    invalidatePermissionsCache();
    // An edited built-in is the workspace's now: the startup seed leaves it.
    if (builtin) {
      await prisma.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: customizedRoleKey(roleId) } },
        create: { tenantId, key: customizedRoleKey(roleId), value: { at: new Date().toISOString(), by: req.user?.userId ?? null }, updatedBy: req.user?.userId },
        update: { value: { at: new Date().toISOString(), by: req.user?.userId ?? null }, updatedBy: req.user?.userId },
      });
    }
    const after = [...new Set(features)].sort();
    void writeAudit({ tenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_UPDATED, targetType: "role", targetId: roleId,
      metadata: { change: "features", before, after,
        added: after.filter((f) => !before.includes(f)), removed: before.filter((f) => !after.includes(f)) } });
    const updated = await prisma.tenantRole.findUnique({
      where: { id: roleId },
      include: { features: true },
    });
    res.json({ data: updated });
  },
);

// Reset a built-in role to the product's defaults; the seed follows the
// catalog for it again.
router.post(
  "/roles/:roleId/reset",
  ...ADMIN_ONLY,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const roleId = req.params.roleId as string;
    const role = await ensureRoleBelongsToTenant(roleId, tenantId);
    if (!role) { res.status(404).json({ error: "Role not found" }); return; }
    const builtin = isBuiltinKey((role as any).builtinKey) ? ((role as any).builtinKey as BuiltinKey) : null;
    if (!builtin || builtin === "admin") { res.status(409).json({ error: "Only a built-in role has defaults", code: "NOT_BUILTIN" }); return; }
    const defaults = BUILTIN_ROLES[builtin].permissions;
    if (refusedGrant(res, await patternsRefusal(actorOf(req), defaults))) return;
    const before = (await prisma.tenantRoleFeature.findMany({ where: { roleId }, select: { feature: true } })).map((f) => f.feature).sort();
    await prisma.$transaction([
      prisma.tenantRoleFeature.deleteMany({ where: { roleId } }),
      prisma.tenantRoleFeature.createMany({ data: defaults.map((feature) => ({ roleId, feature })), skipDuplicates: true }),
      prisma.tenantSetting.deleteMany({ where: { tenantId, key: customizedRoleKey(roleId) } }),
    ]);
    invalidatePermissionsCache();
    const after = [...new Set(defaults)].sort();
    void writeAudit({ tenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_UPDATED, targetType: "role", targetId: roleId,
      metadata: { change: "reset", before, after, added: after.filter((f) => !before.includes(f)), removed: before.filter((f) => !after.includes(f)) } });
    const updated = await prisma.tenantRole.findUnique({ where: { id: roleId }, include: { features: true } });
    res.json({ data: roleView(updated, new Set()) });
  },
);

// ─── User role assignments ─────────────────────────────────────
router.post(
  "/users/:userId/roles/:roleId",
  ...ADMIN_ONLY,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const userId = req.params.userId as string;
    const roleId = req.params.roleId as string;
    if (!(await ensureUserBelongsToTenant(userId, tenantId))) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const role = await ensureRoleBelongsToTenant(roleId, tenantId);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    if ((role as any).builtinKey === "admin") { res.status(409).json({ error: "Admin is now part of Owner", code: "ROLE_MERGED" }); return; }
    if (refusedGrant(res, await targetRefusal(actorOf(req), tenantId, userId))) return;
    if (refusedGrant(res, await roleRefusal(actorOf(req), tenantId, roleId))) return;
    // The latest assignment is the effective role: assigning "agent" to an admin demotes them.
    try {
      await changeRoles({
        tenantId, actorId: req.user?.userId, targetUserId: userId,
        change: async (tx) => { await tx.userRoleAssignment.upsert({ where: { userId_roleId: { userId, roleId } }, create: { userId, roleId, assignedBy: req.user?.userId }, update: {} }); },
      });
    } catch (err) {
      if (refused(res, err)) return;
      throw err;
    }
    const assignment = await prisma.userRoleAssignment.findFirst({ where: { userId, roleId } });
    invalidatePermissionsCache({ userId });
    void writeAudit({ tenantId: assertTenantId(req), actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_ASSIGNED, targetType: "user", targetId: userId, metadata: { roleId } });
    res.status(201).json({ data: assignment });
  },
);

router.delete(
  "/users/:userId/roles/:roleId",
  ...ADMIN_ONLY,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const userId = req.params.userId as string;
    const roleId = req.params.roleId as string;
    if (!(await ensureUserBelongsToTenant(userId, tenantId))) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (refusedGrant(res, await targetRefusal(actorOf(req), tenantId, userId))) return;
    const removing = await prisma.userRoleAssignment.findFirst({ where: { userId, roleId }, select: { role: { select: { builtinKey: true } } } });
    try {
      await changeRoles({
        tenantId, actorId: req.user?.userId, targetUserId: userId,
        removedAdminRole: removing?.role.builtinKey === "owner" || removing?.role.builtinKey === "admin",
        change: async (tx) => { await tx.userRoleAssignment.deleteMany({ where: { userId, roleId } }); },
      });
    } catch (err) {
      if (refused(res, err)) return;
      throw err;
    }
    void writeAudit({ tenantId: assertTenantId(req), actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_UNASSIGNED, targetType: "user", targetId: userId, metadata: { roleId } });
    invalidatePermissionsCache({ userId });
    res.status(204).end();
  },
);

// ─── Feature registry (read-only, legacy) ──────────────────────
router.get("/features", ...ANY_USER, (_req: Request, res: Response): void => {
  res.json({
    data: ALL_FEATURES.map((key) => FEATURE_METADATA[key]),
  });
});

// ─── Permission catalog (read-only) - single source of truth ────
// Drives the User Management UI: the permission picker + built-in roles +
// scope options. Hierarchical (feature:sub-feature:action), grouped by domain.
// In the reader's language (the request's, else their own, else the
// workspace's); a string with no Hebrew keeps its English.
router.get("/catalog", ...ANY_USER, async (req: Request, res: Response): Promise<void> => {
  const locale = await readerLocale(req);
  const byDomain = Object.fromEntries(
    Object.entries(listPermissionsByDomain()).map(([domain, list]) => [domain, list.map((p) => permissionFor(p, locale))]),
  );
  res.json({
    data: {
      permissions: PERMISSIONS.map((p) => permissionFor(p, locale)),
      byDomain,
      builtinRoles: BUILTIN_ROLE_ORDER.map((k) => roleFor(BUILTIN_ROLES[k], locale)),
      scopes: SCOPE_ORDER,
    },
  });
});

// ─── Set a user's primary role (+ optional scope) ───────────────
// The User Management UX is "one role + additional permissions". This replaces
// the user's role assignment with the single chosen role and applies the scope
// override. Additional permissions remain managed via the grants endpoints.
const setUserRoleSchema = z.object({
  roleId: z.string().min(1),
  scope: z.enum(["OWN", "TEAM", "DEPARTMENT", "WORKSPACE"]).nullable().optional(),
});

router.put(
  "/users/:userId/role",
  ...ADMIN_ONLY,
  validate(setUserRoleSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = assertTenantId(req);
    const userId = req.params.userId as string;
    const { roleId, scope } = req.body as z.infer<typeof setUserRoleSchema>;
    if (!(await ensureUserBelongsToTenant(userId, tenantId))) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const role = await ensureRoleBelongsToTenant(roleId, tenantId);
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }
    if ((role as any).builtinKey === "admin") { res.status(409).json({ error: "Admin is now part of Owner", code: "ROLE_MERGED" }); return; }
    if (refusedGrant(res, await targetRefusal(actorOf(req), tenantId, userId))) return;
    if (refusedGrant(res, await roleRefusal(actorOf(req), tenantId, roleId))) return;
    try {
      await changeRoles({
        tenantId, actorId: req.user?.userId, targetUserId: userId,
        change: async (tx) => {
          await tx.userRoleAssignment.deleteMany({ where: { userId } });
          await tx.userRoleAssignment.create({ data: { userId, roleId, scope: scope ?? null, assignedBy: req.user?.userId } });
        },
      });
    } catch (err) {
      if (refused(res, err)) return;
      throw err;
    }
    invalidatePermissionsCache({ userId });
    void writeAudit({ tenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_ASSIGNED, targetType: "user", targetId: userId, metadata: { roleId, replacedAll: true } });
    const assignment = await prisma.userRoleAssignment.findFirst({
      where: { userId, roleId },
      include: { role: true },
    });
    res.json({ data: assignment });
  },
);

export default router;
