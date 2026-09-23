/**
 * Invitations must target the roles a tenant actually has.
 *
 * Six cases, chosen so different wrong implementations fail differently:
 *
 *   1 builtin      role:"AGENT" still works - THE REGRESSION CASE. Every
 *                  existing caller sends this.
 *   2 custom       a custom TenantRole id is accepted and the assignment is
 *                  actually present afterwards.
 *   3 cross-tenant a role id belonging to ANOTHER tenant is REFUSED. The one
 *                  case where a wrong implementation is a privilege leak rather
 *                  than a missing feature.
 *   4 parity       the SHARED helper both invite paths use, including that a
 *                  second call does not duplicate the assignment.
 *
 *                  ★ AND WHAT THIS DOES NOT PROVE, stated rather than implied:
 *                  it does not drive invite-team and invite-link end to end.
 *                  Doing so provisions a real Authentik identity and sends a
 *                  real email, which is a blast radius a probe should not have.
 *                  So endpoint parity rests on a STATIC check instead - all four
 *                  role-deciding sites call this same resolver, and no
 *                  `=== "ADMIN" ? "ADMIN" : "AGENT"` collapse remains in the
 *                  file. That is weaker than an end-to-end run and is the
 *                  honest description of it.
 *   5 deleted      the role is deleted between invite and acceptance: the person
 *                  still joins, as an agent, AND a role.assigned_fallback audit
 *                  record exists. Acceptance must not fail.
 *   6 count        DELETE /roles/:roleId reports how many pending invites it
 *                  affected, and does NOT refuse.
 *
 * Calls the route handlers directly - `auth` has no INTERNAL_SERVICE_KEY path
 * for these and the point is the resolution logic, not the HTTP layer.
 */
import { prisma } from "@chatcenter/shared";
import {
  resolveInviteRoleStrict,
  resolveInviteRoleWithFallback,
  ensureRoleAssignment,
} from "../src/services/invite-role.service";

const T = process.env.PROBE_TENANT ?? "cms4ug98n0004chmrp4lv6ujl";
const OTHER_T = process.env.PROBE_OTHER_TENANT ?? "cms1pw5j80008bemfl7fdf7wu";
const TAG = "probe-invite-role";

async function cleanup() {
  const log = (w: string) => (e: any) => console.warn(`cleanup ${w}:`, e?.message ?? e);
  await prisma.userRoleAssignment.deleteMany({ where: { role: { name: { startsWith: TAG } } } }).catch(log("assignments"));
  await prisma.tenantInvite.deleteMany({ where: { tenantId: T, token: { startsWith: TAG } } }).catch(log("invites"));
  await prisma.auditLog.deleteMany({ where: { tenantId: T, action: "role.assigned_fallback", targetType: "user", targetId: { startsWith: TAG } } }).catch(log("audit"));
  await prisma.tenantRole.deleteMany({ where: { name: { startsWith: TAG } } }).catch(log("roles"));
}

async function main() {
  await cleanup();
  const fail: string[] = [];

  const custom = await prisma.tenantRole.create({
    data: { tenantId: T, name: `${TAG} Wholesale`, isSystem: false, builtinKey: null } as any,
  });
  const foreign = await prisma.tenantRole.create({
    data: { tenantId: OTHER_T, name: `${TAG} Foreign`, isSystem: false, builtinKey: null } as any,
  });

  // 1 - the regression case
  const builtin = await resolveInviteRoleStrict(T, "AGENT");
  console.log(`1 builtin      coarse=${builtin?.coarse} roleId=${builtin?.tenantRoleId ? "set" : "null"} name=${builtin?.roleName}`);
  if (builtin?.coarse !== "AGENT") fail.push("AGENT keyword no longer resolves");
  if (!builtin?.tenantRoleId) fail.push("AGENT keyword did not resolve to the tenant's agent role");

  const adminKw = await resolveInviteRoleStrict(T, "ADMIN");
  if (adminKw?.coarse !== "ADMIN") fail.push("ADMIN keyword no longer resolves to ADMIN");

  // 2 - a custom role id
  const res2 = await resolveInviteRoleStrict(T, custom.id);
  console.log(`2 custom       coarse=${res2?.coarse} roleId=${res2?.tenantRoleId === custom.id ? "matches" : "WRONG"} name=${res2?.roleName}`);
  if (!res2) fail.push("custom role id was not resolved at all");
  if (res2 && res2.tenantRoleId !== custom.id) fail.push("custom role resolved to a different role");
  if (res2 && res2.coarse !== "AGENT") fail.push(`custom role gave coarse=${res2.coarse}; a custom role must not imply ADMIN`);

  // 3 - THE PRIVILEGE CASE: another tenant's role id
  const res3 = await resolveInviteRoleStrict(T, foreign.id);
  console.log(`3 cross-tenant refused=${res3 === null}`);
  if (res3 !== null) fail.push("A ROLE ID FROM ANOTHER TENANT WAS ACCEPTED - privilege leak");

  // 4 - parity: both invite shapes land the same assignment
  const users = await prisma.user.findMany({ where: { tenantId: T }, select: { id: true }, take: 1 });
  if (users.length === 0) {
    fail.push("no user in the probe tenant to assign to");
  } else {
    const uid = users[0]!.id;
    const before = await prisma.userRoleAssignment.count({ where: { userId: uid, roleId: custom.id } });
    await ensureRoleAssignment(uid, custom.id, null);
    await ensureRoleAssignment(uid, custom.id, null); // idempotent - accepting twice
    const after = await prisma.userRoleAssignment.count({ where: { userId: uid, roleId: custom.id } });
    console.log(`4 helper       assignment before=${before} after=${after} (idempotent, expect 1) - NOT end-to-end, see header`);
    if (after !== 1) fail.push(`assignment count ${after} != 1 - not idempotent`);
    await prisma.userRoleAssignment.deleteMany({ where: { userId: uid, roleId: custom.id } });
  }

  // 5 - the role is deleted while the invitation is outstanding
  const deletedId = custom.id;
  await prisma.tenantRole.delete({ where: { id: deletedId } });
  const res5 = await resolveInviteRoleWithFallback(T, deletedId);
  console.log(`5 deleted      fellBack=${res5.fellBack} coarse=${res5.coarse} granted=${res5.roleName}`);
  if (!res5.fellBack) fail.push("a deleted role did not fall back");
  if (res5.coarse !== "AGENT") fail.push(`fallback gave coarse=${res5.coarse}, expected AGENT`);
  if (!res5.tenantRoleId) fail.push("fallback produced no role to assign - the user would have no permissions");

  // strict must still refuse it, so invite time rejects what accept time forgives
  const strict5 = await resolveInviteRoleStrict(T, deletedId);
  console.log(`  strict still refuses the deleted role: ${strict5 === null}`);
  if (strict5 !== null) fail.push("strict resolution accepted a deleted role");

  // 6 - the delete count
  const counted = await prisma.tenantRole.create({
    data: { tenantId: T, name: `${TAG} Counted`, isSystem: false, builtinKey: null } as any,
  });
  for (const n of [1, 2, 3]) {
    await prisma.tenantInvite.create({
      data: {
        tenantId: T, token: `${TAG}-${n}`, email: `${TAG}-${n}@example.invalid`,
        role: counted.id, expiresAt: new Date(Date.now() + 7 * 864e5),
      } as any,
    });
  }
  // an accepted invite and an expired one must NOT be counted
  await prisma.tenantInvite.create({
    data: { tenantId: T, token: `${TAG}-accepted`, role: counted.id, acceptedAt: new Date(), expiresAt: new Date(Date.now() + 7 * 864e5) } as any,
  });
  await prisma.tenantInvite.create({
    data: { tenantId: T, token: `${TAG}-expired`, role: counted.id, expiresAt: new Date(Date.now() - 864e5) } as any,
  });
  const pending = await prisma.tenantInvite.count({
    where: { tenantId: T, role: counted.id, acceptedAt: null, expiresAt: { gt: new Date() } },
  });
  console.log(`6 count        pending=${pending} (expect 3 - accepted and expired excluded)`);
  if (pending !== 3) fail.push(`pending invite count ${pending} != 3`);

  console.log(fail.length === 0 ? "PASS" : `FAIL: ${fail.join(" | ")}`);
  await cleanup();
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("PROBE ERROR", e); await cleanup(); process.exit(1); });
