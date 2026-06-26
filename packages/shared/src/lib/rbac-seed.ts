/**
 * RBAC seed + backfill — idempotent.
 *
 *   seedTenantRoles(tenantId)        seed the 4 built-in system roles + their
 *                                    permission rows from the catalog.
 *   backfillTenantAssignments(id)    give every user a role assignment derived
 *                                    from the legacy Role/DepartmentRole, so
 *                                    existing access is preserved EXACTLY.
 *   seedTenantRbac(tenantId)         both, in order.
 *   seedAllTenantsRbac()             loop every tenant.
 *
 * Safe to re-run: roles are upserted by (tenantId, builtinKey); permission
 * rows use skipDuplicates; assignments are only created for users that have
 * none yet (admin edits + manual assignments are never clobbered).
 */

import { prisma } from "./prisma";
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_ORDER,
  builtinRoleForLegacy,
  type BuiltinRoleKey,
} from "./permission-catalog";
import { scopeToDb as toDbScope, invalidatePermissionsCache } from "./permissions";

/** Ensure the 4 built-in system roles + their permission rows exist for a tenant. */
export async function seedTenantRoles(tenantId: string): Promise<Record<BuiltinRoleKey, string>> {
  const ids = {} as Record<BuiltinRoleKey, string>;

  for (const key of BUILTIN_ROLE_ORDER) {
    const def = BUILTIN_ROLES[key];

    // Upsert by builtin identity. We match on (tenantId, name) because that's
    // the existing unique constraint, but keep builtinKey authoritative.
    const existing = await prisma.tenantRole.findFirst({
      where: { tenantId, OR: [{ builtinKey: key }, { name: def.name }] },
      select: { id: true },
    });

    let roleId: string;
    if (existing) {
      const updated = await prisma.tenantRole.update({
        where: { id: existing.id },
        data: {
          builtinKey: key,
          isSystem: true,
          defaultScope: toDbScope(def.defaultScope),
          description: def.description,
        },
        select: { id: true },
      });
      roleId = updated.id;
    } else {
      const created = await prisma.tenantRole.create({
        data: {
          tenantId,
          name: def.name,
          description: def.description,
          isSystem: true,
          builtinKey: key,
          defaultScope: toDbScope(def.defaultScope),
        },
        select: { id: true },
      });
      roleId = created.id;
    }
    ids[key] = roleId;

    // Built-in roles are system-managed: their permission set is AUTHORITATIVE
    // from the catalog, so catalog changes propagate on re-seed. (Custom roles
    // are never touched here.) Replace the feature rows to match the catalog.
    await prisma.$transaction([
      prisma.tenantRoleFeature.deleteMany({ where: { roleId } }),
      prisma.tenantRoleFeature.createMany({
        data: def.permissions.map((feature) => ({ roleId, feature })),
        skipDuplicates: true,
      }),
    ]);
  }

  invalidatePermissionsCache({ tenantId });
  return ids;
}

/**
 * Backfill role assignments from legacy role columns. Existing access is
 * preserved exactly:
 *   - oldest tenant ADMIN          → Owner
 *   - other ADMINs                 → Admin
 *   - AGENT + departmentRole MANAGER → Department Manager
 *   - AGENT                        → Agent
 *   - SYSTEM_ADMIN                 → skipped (platform tier)
 * Only users with NO existing assignment are touched.
 */
export async function backfillTenantAssignments(tenantId: string): Promise<number> {
  const roleIds = await seedTenantRoles(tenantId);

  const users = await prisma.user.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      createdAt: true,
      departmentMember: { select: { departmentRole: true } },
      roleAssignments: { select: { roleId: true }, take: 1 },
    },
  });

  let ownerAssigned = false;
  let count = 0;

  for (const u of users) {
    if (u.role === "SYSTEM_ADMIN") continue;
    if (u.roleAssignments.length > 0) {
      // Already has an assignment — if it's an Owner, remember that.
      if (u.roleAssignments.some((a) => a.roleId === roleIds.owner)) ownerAssigned = true;
      continue;
    }

    let target: BuiltinRoleKey | null = builtinRoleForLegacy(
      u.role,
      u.departmentMember?.departmentRole ?? null,
    );
    if (!target) continue;

    // First/oldest ADMIN becomes the Owner.
    if (target === "admin" && !ownerAssigned) {
      target = "owner";
      ownerAssigned = true;
    }

    await prisma.userRoleAssignment.create({
      data: {
        userId: u.id,
        roleId: roleIds[target],
        scope: null, // inherit role.defaultScope
        assignedBy: null, // system backfill
      },
    });
    invalidatePermissionsCache({ userId: u.id });
    count++;
  }

  return count;
}

export async function seedTenantRbac(tenantId: string): Promise<{ assignments: number }> {
  await seedTenantRoles(tenantId);
  const assignments = await backfillTenantAssignments(tenantId);
  return { assignments };
}

export async function seedAllTenantsRbac(): Promise<{ tenants: number; assignments: number }> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  let assignments = 0;
  for (const t of tenants) {
    const r = await seedTenantRbac(t.id);
    assignments += r.assignments;
  }
  return { tenants: tenants.length, assignments };
}
