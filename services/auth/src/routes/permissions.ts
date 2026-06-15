import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  prisma,
  authenticate,
  requireRole,
  resolveTenant,
  validate,
  assertTenantId,
  invalidatePermissionsCache,
  getUserFeatures,
  ALL_FEATURES,
  FEATURE_METADATA,
  isFeature,
  type Feature,
} from "@chatcenter/shared";

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

// ─── Self: what features can I access right now? ───────────────
router.get("/me", ...ANY_USER, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const features = await getUserFeatures({
    userId: req.user!.userId,
    tenantId,
    role: req.user!.role,
  });
  res.json({ data: { features, role: req.user!.role } });
});

// ─── User: resolved feature set ────────────────────────────────
router.get("/users/:userId", ...ADMIN_ONLY, async (req: Request, res: Response): Promise<void> => {
  const tenantId = assertTenantId(req);
  const userId = req.params.userId as string;
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, role: true, email: true, name: true },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const features = await getUserFeatures({ userId: user.id, tenantId, role: user.role });
  res.json({ data: { user, features } });
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
    if (!isFeature(feature)) {
      res.status(400).json({ error: "Unknown feature", feature });
      return;
    }
    if (!(await ensureUserBelongsToTenant(userId, tenantId))) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { granted, reason } = req.body as { granted: boolean; reason?: string };
    const row = await prisma.userFeatureGrant.upsert({
      where: { userId_feature: { userId, feature: feature as Feature } },
      create: { userId, feature, granted, reason, updatedBy: req.user?.userId },
      update: { granted, reason, updatedBy: req.user?.userId },
    });
    invalidatePermissionsCache({ userId });
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

    const unknown = features.filter((f) => !isFeature(f));
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
    const updated = await prisma.tenantRole.update({
      where: { id: roleId },
      data: req.body,
    });
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
    const unknown = features.filter((f) => !isFeature(f));
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
    invalidatePermissionsCache({ userId });
    res.status(204).end();
  },
);

// ─── Feature registry (read-only) ──────────────────────────────
router.get("/features", ...ANY_USER, (_req: Request, res: Response): void => {
  res.json({
    data: ALL_FEATURES.map((key) => FEATURE_METADATA[key]),
  });
});

export default router;
