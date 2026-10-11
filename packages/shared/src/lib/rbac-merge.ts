import { prisma } from "./prisma";
import { invalidatePermissionsCache } from "./permissions";

/**
 * Owner and Admin become one role (Omer, 2026-10-11).
 *
 * Every assignment to a tenant's built-in "admin" role moves to its "owner"
 * role. What moved is recorded first, per tenant, in TenantSetting
 * "rbac:merge:owner-admin", so `undoMergeAdminIntoOwner` can put back exactly
 * what was there. The admin role row itself is left in place (hidden by the
 * API), so an undo has somewhere to put people back.
 *
 * The consequence, accepted by Omer: everyone who was an Admin gains what only
 * an Owner had - billing and role management.
 */
export const MERGE_RECORD_KEY = "rbac:merge:owner-admin";

interface MovedAssignment { userId: string; adminRoleId: string; ownerRoleId: string; hadOwner: boolean }
interface MergeRecord { at: string; moved: MovedAssignment[] }

export async function mergeAdminIntoOwner(tenantId: string, by = "script"): Promise<{ moved: number; skipped?: string }> {
  const roles = await prisma.tenantRole.findMany({ where: { tenantId, builtinKey: { in: ["admin", "owner"] } }, select: { id: true, builtinKey: true } });
  const admin = roles.find((r) => r.builtinKey === "admin");
  const owner = roles.find((r) => r.builtinKey === "owner");
  if (!admin) return { moved: 0, skipped: "no admin role" };
  if (!owner) return { moved: 0, skipped: "no owner role" };

  return prisma.$transaction(async (tx) => {
    const assignments = await tx.userRoleAssignment.findMany({ where: { roleId: admin.id }, select: { userId: true } });
    const moved: MovedAssignment[] = [];
    for (const a of assignments) {
      const hadOwner = !!(await tx.userRoleAssignment.findFirst({ where: { userId: a.userId, roleId: owner.id }, select: { userId: true } }));
      if (!hadOwner) await tx.userRoleAssignment.create({ data: { userId: a.userId, roleId: owner.id, assignedBy: by } });
      await tx.userRoleAssignment.deleteMany({ where: { userId: a.userId, roleId: admin.id } });
      moved.push({ userId: a.userId, adminRoleId: admin.id, ownerRoleId: owner.id, hadOwner });
    }
    // Appended, so a second run (new admins assigned since) keeps the first record.
    const prior = await tx.tenantSetting.findFirst({ where: { tenantId, key: MERGE_RECORD_KEY }, select: { value: true } });
    const record: MergeRecord = { at: new Date().toISOString(), moved: [...(((prior?.value as any)?.moved ?? []) as MovedAssignment[]), ...moved] };
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: MERGE_RECORD_KEY } },
      create: { tenantId, key: MERGE_RECORD_KEY, value: record as any, updatedBy: by },
      update: { value: record as any, updatedBy: by },
    });
    for (const m of moved) invalidatePermissionsCache({ userId: m.userId });
    return { moved: moved.length };
  });
}

/** The inverse: everyone the merge moved goes back to Admin; an Owner they already had stays. */
export async function undoMergeAdminIntoOwner(tenantId: string, by = "script"): Promise<{ restored: number }> {
  const row = await prisma.tenantSetting.findFirst({ where: { tenantId, key: MERGE_RECORD_KEY }, select: { value: true } });
  const moved = (((row?.value as any)?.moved ?? []) as MovedAssignment[]);
  if (!moved.length) return { restored: 0 };
  return prisma.$transaction(async (tx) => {
    for (const m of moved) {
      await tx.userRoleAssignment.upsert({
        where: { userId_roleId: { userId: m.userId, roleId: m.adminRoleId } },
        create: { userId: m.userId, roleId: m.adminRoleId, assignedBy: by },
        update: {},
      });
      if (!m.hadOwner) await tx.userRoleAssignment.deleteMany({ where: { userId: m.userId, roleId: m.ownerRoleId } });
    }
    await tx.tenantSetting.deleteMany({ where: { tenantId, key: MERGE_RECORD_KEY } });
    for (const m of moved) invalidatePermissionsCache({ userId: m.userId });
    return { restored: moved.length };
  });
}
