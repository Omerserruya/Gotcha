/**
 * RBAC seed + backfill - idempotent.
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
  rolesEditable,
  type BuiltinRoleKey,
} from "./permission-catalog";

/**
 * Marks a built-in role a workspace has edited. The seed leaves its features
 * alone from then on; "Reset to default" removes the marker. A TenantSetting
 * row, so no migration (2026-10-11).
 */
export const customizedRoleKey = (roleId: string) => `rbac:customized:${roleId}`;
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

    // Built-in roles follow the catalog - so catalog changes propagate on
    // re-seed - UNTIL a workspace edits one (2026-10-11): an edited built-in
    // is the workspace's, and a restart must not wipe it. With the kill switch
    // (ROLES_EDITABLE=false) every built-in follows the catalog again.
    // Custom roles are never touched here.
    if (rolesEditable()) {
      const customized = await prisma.tenantSetting.findFirst({ where: { tenantId, key: customizedRoleKey(roleId) }, select: { key: true } });
      if (customized) continue;
    }
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
      departmentMembers: { select: { departmentRole: true }, orderBy: { createdAt: "asc" as const }, take: 1 },
      // The role's tenant comes too: an assignment pointing at ANOTHER
      // organization's role is not a valid assignment, and treating it as one
      // is how such a row survives every subsequent re-seed.
      roleAssignments: { select: { roleId: true, role: { select: { tenantId: true } } } },
    },
  });

  let ownerAssigned = false;
  let count = 0;

  for (const u of users) {
    if (u.role === "SYSTEM_ADMIN") continue;

    // Only assignments to THIS tenant's roles count as having one. A row
    // pointing at another organization's role is repaired rather than
    // respected - left alone it keeps this user's access hostage to a role
    // nobody in this tenant can see or edit, and one that disappears entirely
    // if that other organization is ever deleted.
    const foreign = u.roleAssignments.filter((a) => a.role.tenantId !== tenantId);
    const own = u.roleAssignments.filter((a) => a.role.tenantId === tenantId);

    if (foreign.length) {
      await prisma.userRoleAssignment.deleteMany({
        where: { userId: u.id, roleId: { in: foreign.map((a) => a.roleId) } },
      });
      invalidatePermissionsCache({ userId: u.id });
    }

    if (own.length > 0) {
      // Already correctly assigned - if it's an Owner, remember that.
      if (own.some((a) => a.roleId === roleIds.owner)) ownerAssigned = true;
      continue;
    }

    let target: BuiltinRoleKey | null = builtinRoleForLegacy(
      u.role,
      u.departmentMembers?.[0]?.departmentRole ?? null,
    );
    if (!target) continue;

    // Owner and Admin are one role (2026-10-11): every legacy ADMIN is an
    // Owner (builtinRoleForLegacy), not only the oldest.
    if (target === "owner") ownerAssigned = true;

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
