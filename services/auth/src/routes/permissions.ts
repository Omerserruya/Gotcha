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
  SCOPE_ORDER,
  isPermissionKey,
  expandPermissionPattern,
  listPermissionsByDomain,
} from "@chatcenter/shared";

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
        take: 1,
      },
      roleAssignments: {
        select: { scope: true, role: { select: { id: true, name: true, builtinKey: true, defaultScope: true } } },
      },
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
      departmentId: u.departmentMembers?.[0]?.departmentId ?? null,
      departmentRole: u.departmentMembers?.[0]?.departmentRole ?? null,
      departmentName: u.departmentMembers?.[0]?.department?.name ?? null,
      roleId: assignment?.role.id ?? null,
      roleName: assignment?.role.name ?? null,
      roleBuiltinKey: assignment?.role.builtinKey ?? null,
      scope: assignment?.scope ?? assignment?.role.defaultScope ?? null,
    };
  });
  res.json({ data });
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
      featureGrants: { select: { feature: true, granted: true, reason: true } },
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
      grants: user.featureGrants,
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
  res.json({ data: grants });
});

const upsertGrantSchema = z.object({
  granted: z.boolean(),
  reason: z.string().max(500).optional(),
});

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
    const _auditTenantId = assertTenantId(req);
    const row = await prisma.userFeatureGrant.upsert({
      where: { userId_feature: { userId, feature: feature as Feature } },
      create: { userId, feature, granted, reason, updatedBy: req.user?.userId },
      update: { granted, reason, updatedBy: req.user?.userId },
    });
    invalidatePermissionsCache({ userId });
    void writeAudit({ tenantId: _auditTenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.FEATURE_GRANT_CHANGED, targetType: "user", targetId: userId, metadata: { feature } });
    res.json({ data: row });
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
    await prisma.userFeatureGrant.deleteMany({ where: { userId, feature } });
    void writeAudit({ tenantId: assertTenantId(req), actorType: "user", actorId: req.user?.userId,
      action: AuditAction.PERMISSION_REVOKED, targetType: "user", targetId: userId, metadata: { feature } });
    invalidatePermissionsCache({ userId });
    res.status(204).end();
  },
);

// ─── Custom tenant roles ───────────────────────────────────────
router.get("/roles", ...ADMIN_ONLY, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const roles = await prisma.tenantRole.findMany({
    where: { tenantId },
    include: { features: true, _count: { select: { assignments: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ data: roles });
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
        res.status(409).json({ error: "Role with this name already exists" });
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
      res.status(403).json({ error: "System roles cannot be modified" });
      return;
    }
    // Explicit allowlist (updateRoleSchema fields). isSystem, tenantId, and
    // feature grants are never settable via this body.
    const { name, description } = req.body as { name?: string; description?: string | null };
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    const updated = await prisma.tenantRole.update({
      where: { id: roleId },
      data,
    });
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
      res.status(403).json({ error: "System roles cannot be deleted" });
      return;
    }
    await prisma.tenantRole.delete({ where: { id: roleId } });
    void writeAudit({ tenantId, actorType: "user", actorId: req.user?.userId,
      action: AuditAction.ROLE_DELETED, targetType: "role", targetId: roleId });
    // Cascade deletes assignments + role_features; invalidate user caches broadly.
    invalidatePermissionsCache();
    res.status(204).end();
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
    const { features } = req.body as { features: string[] };
    const unknown = features.filter((f) => !isGrantableKey(f));
    if (unknown.length) {
      res.status(400).json({ error: "Unknown features", features: unknown });
      return;
    }

    await prisma.$transaction([
      prisma.tenantRoleFeature.deleteMany({ where: { roleId } }),
      prisma.tenantRoleFeature.createMany({
        data: features.map((feature) => ({ roleId, feature })),
        skipDuplicates: true,
      }),
    ]);
    invalidatePermissionsCache();
    const updated = await prisma.tenantRole.findUnique({
      where: { id: roleId },
      include: { features: true },
    });
    res.json({ data: updated });
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
    const assignment = await prisma.userRoleAssignment.upsert({
      where: { userId_roleId: { userId, roleId } },
      create: { userId, roleId, assignedBy: req.user?.userId },
      update: {},
    });
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
    await prisma.userRoleAssignment.deleteMany({ where: { userId, roleId } });
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
router.get("/catalog", ...ANY_USER, (_req: Request, res: Response): void => {
  res.json({
    data: {
      permissions: PERMISSIONS,
      byDomain: listPermissionsByDomain(),
      builtinRoles: BUILTIN_ROLE_ORDER.map((k) => BUILTIN_ROLES[k]),
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
    await prisma.$transaction([
      prisma.userRoleAssignment.deleteMany({ where: { userId } }),
      prisma.userRoleAssignment.create({
        data: { userId, roleId, scope: scope ?? null, assignedBy: req.user?.userId },
      }),
    ]);
    invalidatePermissionsCache({ userId });
    const assignment = await prisma.userRoleAssignment.findFirst({
      where: { userId, roleId },
      include: { role: true },
    });
    res.json({ data: assignment });
  },
);

export default router;
