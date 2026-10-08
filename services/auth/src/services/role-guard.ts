/**
 * Changing a person's role without locking the workspace out of itself.
 *
 * Three routes change who is an admin (PUT /users/:id/role, POST and DELETE
 * /users/:id/roles/:roleId: the LATEST assignment wins, so assigning "agent"
 * demotes). None of them could tell that it removed the last admin, or the
 * caller's own admin; and none touched User.role, so a legacy ADMIN
 * "changed to Agent" showed Agent and stayed an admin (requireRole passes on
 * the enum OR the assigned built-in).
 *
 * One truth: the assigned built-in is authoritative and User.role is kept in
 * step with it in the same transaction (never for SYSTEM_ADMIN, the platform
 * tier). The change, the sync and the checks run under a per-workspace lock,
 * so two admins demoting each other at the same moment cannot both pass.
 *
 * Who counts as an admin: requireRole("ADMIN")'s own rule, on the state after
 * the change: User.role ADMIN, or the latest assignment is owner or admin.
 * Other services cache the effective built-in for up to 30 seconds
 * (USER_CACHE_TTL_MS); the enum, read on every request, changes at once.
 */
import { prisma } from "@chatcenter/shared";

const ADMIN_BUILTINS = new Set(["owner", "admin"]);

export class RoleChangeRefused extends Error {
  constructor(public code: "LAST_ADMIN" | "SELF_LOCKOUT") {
    super(code === "LAST_ADMIN"
      ? "This would leave the workspace without an admin"
      : "You cannot remove your own admin role");
  }
}

/** The transaction client of the shared (extended) prisma. */
type Tx = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/** The latest assignment's built-in key in this workspace, or null when none. */
async function latestBuiltin(tx: Tx, userId: string, tenantId: string): Promise<string | null> {
  const a = await tx.userRoleAssignment.findFirst({
    where: { userId, role: { tenantId } },
    orderBy: { assignedAt: "desc" },
    select: { role: { select: { builtinKey: true } } },
  });
  return a ? (a.role.builtinKey ?? "") : null;
}

/**
 * Run a role change for `targetUserId` in `tenantId`, keep User.role in step,
 * and refuse (rolling everything back) a change that leaves no admin or takes
 * the caller's own admin away.
 */
export async function changeRoles(opts: {
  tenantId: string;
  actorId: string | undefined;
  targetUserId: string;
  /** The assignment writes themselves. */
  change: (tx: Tx) => Promise<void>;
  /** True when the change removed an owner/admin assignment (a user left without any assignment then loses admin too). */
  removedAdminRole?: boolean;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // One role change at a time per workspace.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`roles:${opts.tenantId}`}))`;
    await opts.change(tx);

    const target = await tx.user.findFirst({ where: { id: opts.targetUserId, tenantId: opts.tenantId }, select: { role: true } });
    if (target && target.role !== "SYSTEM_ADMIN") {
      const key = await latestBuiltin(tx, opts.targetUserId, opts.tenantId);
      const next = key !== null
        ? (ADMIN_BUILTINS.has(key) ? "ADMIN" : "AGENT")
        : (opts.removedAdminRole ? "AGENT" : target.role);
      if (next !== target.role) await tx.user.update({ where: { id: opts.targetUserId }, data: { role: next as any } });
    }

    // requireRole's rule, after the change.
    const isAdmin = async (u: { id: string; role: string }) =>
      u.role === "ADMIN" || ADMIN_BUILTINS.has((await latestBuiltin(tx, u.id, opts.tenantId)) ?? "");
    if (opts.actorId === opts.targetUserId) {
      const me = await tx.user.findFirst({ where: { id: opts.actorId, tenantId: opts.tenantId }, select: { id: true, role: true } });
      if (me && me.role !== "SYSTEM_ADMIN" && !(await isAdmin(me))) throw new RoleChangeRefused("SELF_LOCKOUT");
    }
    const members = await tx.user.findMany({ where: { tenantId: opts.tenantId, isActive: true, role: { not: "SYSTEM_ADMIN" } }, select: { id: true, role: true } });
    let admins = 0;
    for (const m of members) if (await isAdmin(m)) admins++;
    if (admins === 0) throw new RoleChangeRefused("LAST_ADMIN");
  });
}
