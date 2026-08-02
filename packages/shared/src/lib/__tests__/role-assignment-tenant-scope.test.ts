/**
 * A role assignment belongs to one organization, and so does the role.
 *
 * The dev estate had a row where it did not: the ADMIN of tenant "urban" was
 * assigned demo-company's Owner role. Nothing looked wrong, because both Owner
 * rows are seeded from the same catalog and resolved to the same permissions.
 *
 * What made it dangerous was invisible: urban's owner held a role nobody in
 * urban could see or edit, editing demo-company's Owner would have silently
 * changed urban's owner, and deleting demo-company would have cascaded the role
 * away and stripped them of their assignment entirely.
 *
 * So the resolver refuses to read a foreign role, and the seeder repairs one
 * rather than skipping the user as "already assigned".
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../prisma";
import { seedTenantRbac } from "../rbac-seed";
import { getEffectiveBuiltinRole, invalidatePermissionsCache } from "../permissions";

const RUN = `rolescope-${Date.now()}`;
const tenantIds: string[] = [];
const identityIds: string[] = [];

async function tenantWithAdmin(label: string) {
  const n = `${RUN}-${label}-${Math.random().toString(36).slice(2, 7)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  tenantIds.push(t.id);
  const identity = await prisma.identity.create({
    data: { email: `${n}@example.test`, name: n, authentikSubject: `sub-${n}` },
  });
  identityIds.push(identity.id);
  const user = await prisma.user.create({
    data: { tenantId: t.id, identityId: identity.id, email: `${n}@example.test`, name: n, role: "ADMIN" },
  });
  await seedTenantRbac(t.id);
  return { tenant: t, user };
}

const principal = (u: { id: string; tenantId: string }) =>
  ({ userId: u.id, tenantId: u.tenantId, role: "ADMIN" }) as any;

afterAll(async () => {
  await prisma.userRoleAssignment.deleteMany({ where: { user: { tenantId: { in: tenantIds } } } });
  await prisma.tenantRoleFeature.deleteMany({ where: { role: { tenantId: { in: tenantIds } } } });
  await prisma.tenantRole.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.identity.deleteMany({ where: { id: { in: identityIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("seeding assigns a role from the user's own tenant", () => {
  it("never reaches into another organization's roles", async () => {
    await tenantWithAdmin("other"); // exists first, with an identically-named Owner
    const { tenant, user } = await tenantWithAdmin("mine");

    const rows = await prisma.userRoleAssignment.findMany({
      where: { userId: user.id },
      include: { role: { select: { tenantId: true, builtinKey: true } } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role.builtinKey).toBe("owner");
    expect(rows[0]!.role.tenantId).toBe(tenant.id);
  });
});

describe("a foreign assignment is repaired, not respected", () => {
  it("re-seeding replaces it with this tenant's own role", async () => {
    const other = await tenantWithAdmin("foreignsrc");
    const mine = await tenantWithAdmin("victim");

    const foreignOwner = await prisma.tenantRole.findFirst({
      where: { tenantId: other.tenant.id, builtinKey: "owner" },
      select: { id: true },
    });

    // Recreate the exact bad row: this tenant's admin pointed at the other
    // tenant's Owner.
    await prisma.userRoleAssignment.deleteMany({ where: { userId: mine.user.id } });
    await prisma.userRoleAssignment.create({
      data: { userId: mine.user.id, roleId: foreignOwner!.id },
    });
    invalidatePermissionsCache({ userId: mine.user.id });

    // The resolver must not read it. Falling back to the legacy enum bridge is
    // the correct answer - it is this tenant's own information.
    const before = await getEffectiveBuiltinRole(principal(mine.user));
    expect(before).not.toBeNull();
    const stillForeign = await prisma.userRoleAssignment.findFirst({
      where: { userId: mine.user.id },
      include: { role: { select: { tenantId: true } } },
    });
    expect(stillForeign!.role.tenantId).toBe(other.tenant.id);

    // Re-seeding repairs it. Before, the user was skipped as "already
    // assigned", so the bad row survived every subsequent seed forever.
    await seedTenantRbac(mine.tenant.id);

    const after = await prisma.userRoleAssignment.findMany({
      where: { userId: mine.user.id },
      include: { role: { select: { tenantId: true, builtinKey: true } } },
    });
    expect(after).toHaveLength(1);
    expect(after[0]!.role.tenantId).toBe(mine.tenant.id);
    expect(after[0]!.role.builtinKey).toBe("owner");
  });

  it("leaves a correctly-scoped assignment alone", async () => {
    const { tenant, user } = await tenantWithAdmin("stable");
    const before = await prisma.userRoleAssignment.findFirst({ where: { userId: user.id } });
    await seedTenantRbac(tenant.id);
    const after = await prisma.userRoleAssignment.findFirst({ where: { userId: user.id } });
    // Same row, not deleted and recreated - re-seeding is not a reset.
    expect(after!.roleId).toBe(before!.roleId);
    expect(after!.assignedAt.getTime()).toBe(before!.assignedAt.getTime());
  });
});
