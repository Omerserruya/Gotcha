/**
 * What role does an invitation actually grant?
 *
 * A tenant could create a custom role and had no way to invite anyone into it:
 * `invite-team` accepted `"ADMIN" | "AGENT"` and everything downstream
 * collapsed to that pair. This resolves an invite's stored role - built-in
 * keyword or `TenantRole` id - into BOTH things a joining user needs.
 *
 * TWO ROLE SYSTEMS, AND A USER NEEDS BOTH.
 *   User.role              the coarse legacy enum (ADMIN | AGENT). Still what
 *                          `requireRole` reads, so it cannot be skipped.
 *   UserRoleAssignment     the real system - the actual permission set.
 * `inviteUser` only ever wrote the first, so every invited user has had zero
 * entries in the second since the role system was built. Writing one and not
 * the other produces a user who is half-privileged in a way neither screen
 * shows.
 *
 * THE CROSS-TENANT CHECK IS THE POINT OF PUTTING THIS IN ONE PLACE. A role id
 * is opaque and arrives from a client; looked up without its tenant it would
 * let an admin of one organisation grant their people a role defined in
 * another. Every lookup here is `{ id, tenantId }`, and there is no code path
 * that resolves a role id without it.
 */
import { prisma } from "@chatcenter/shared";

export type CoarseRole = "ADMIN" | "AGENT";

export interface ResolvedInviteRole {
  /** What to write to `User.role`. */
  coarse: CoarseRole;
  /** The TenantRole to assign, when the tenant has one. */
  tenantRoleId: string | null;
  /** Display name, for audit records and emails. */
  roleName: string | null;
  /** True when the requested role could not be resolved and agent was used. */
  fellBack: boolean;
}

/**
 * `owner` and `admin` are the two built-ins that map to the ADMIN enum;
 * everything else, including every custom role, maps to AGENT.
 *
 * A custom role's real permissions come from its `TenantRoleFeature` set, not
 * from this enum - the enum only decides the coarse `requireRole` gates. The
 * safe direction for an unknown role is therefore AGENT: a custom role that
 * should have admin reach gets it from its feature set, whereas defaulting to
 * ADMIN would hand `requireRole("ADMIN")` routes to anybody the tenant happened
 * to name.
 */
function coarseFor(builtinKey: string | null): CoarseRole {
  return builtinKey === "owner" || builtinKey === "admin" ? "ADMIN" : "AGENT";
}

/** The tenant's agent role - the fallback, and what a bare "AGENT" means. */
async function agentRole(tenantId: string) {
  return prisma.tenantRole.findFirst({
    where: { tenantId, builtinKey: "agent" },
    select: { id: true, name: true, builtinKey: true },
  });
}

/**
 * Resolve without falling back. Returns null when the value names nothing this
 * tenant has - used at INVITE time, where an unknown role should be refused
 * outright rather than quietly downgraded.
 */
export async function resolveInviteRoleStrict(
  tenantId: string,
  value: string,
): Promise<ResolvedInviteRole | null> {
  const wanted = (value || "").trim();
  if (!wanted) return null;

  // Keywords keep working so every existing caller of invite-team is
  // unaffected. They resolve to the tenant's matching built-in row when it has
  // been seeded, so a keyword invite produces a real assignment too.
  const upper = wanted.toUpperCase();
  if (upper === "ADMIN" || upper === "AGENT") {
    const key = upper === "ADMIN" ? "admin" : "agent";
    const role = await prisma.tenantRole.findFirst({
      where: { tenantId, builtinKey: key },
      select: { id: true, name: true, builtinKey: true },
    });
    return {
      coarse: upper as CoarseRole,
      tenantRoleId: role?.id ?? null,
      roleName: role?.name ?? upper,
      fellBack: false,
    };
  }

  // tenantId in the WHERE, always. A role id from another organisation simply
  // does not match, so it is refused by not being found rather than by a check
  // someone could forget to write.
  const role = await prisma.tenantRole.findFirst({
    where: { id: wanted, tenantId },
    select: { id: true, name: true, builtinKey: true },
  });
  if (!role) return null;

  return {
    coarse: coarseFor(role.builtinKey),
    tenantRoleId: role.id,
    roleName: role.name,
    fellBack: false,
  };
}

/**
 * Resolve, falling back to the tenant's agent role when the requested one no
 * longer exists - used at ACCEPT time.
 *
 * A role can be deleted while an invitation is outstanding. `TenantInvite.role`
 * is a plain string with no foreign key, so the invite keeps pointing at an id
 * that resolves to nothing, and `UserRoleAssignment` has already cascaded away.
 *
 * ACCEPTANCE MUST NOT FAIL FOR THIS. It is the last step of a person joining a
 * company, the invitee is the one person who cannot fix it, and the cause is
 * something an admin did last week. So they join as an agent - and the caller
 * records that, because someone quietly joining with fewer permissions than
 * they were offered is the kind of wrong nobody goes looking for.
 */
export async function resolveInviteRoleWithFallback(
  tenantId: string,
  value: string,
): Promise<ResolvedInviteRole> {
  const strict = await resolveInviteRoleStrict(tenantId, value);
  if (strict) return strict;

  const fallback = await agentRole(tenantId);
  return {
    coarse: "AGENT",
    tenantRoleId: fallback?.id ?? null,
    roleName: fallback?.name ?? "AGENT",
    fellBack: true,
  };
}

/**
 * Give the user their role assignment. Idempotent - accepting twice, or a
 * targeted invite whose user was already created at invite time, must not
 * throw on the composite primary key.
 *
 * Never throws: a failure here leaves the coarse enum correct and the person
 * able to sign in, which is better than failing the join outright. It is
 * logged loudly because a user with no assignment is a user with no
 * permissions in the real system.
 */
export async function ensureRoleAssignment(
  userId: string,
  tenantRoleId: string | null,
  assignedBy?: string | null,
): Promise<void> {
  if (!tenantRoleId) return;
  try {
    await prisma.userRoleAssignment.upsert({
      where: { userId_roleId: { userId, roleId: tenantRoleId } },
      create: { userId, roleId: tenantRoleId, assignedBy: assignedBy ?? null },
      update: {},
    });
  } catch (err: unknown) {
    console.error(
      `[invite-role] assignment failed user=${userId} role=${tenantRoleId}:`,
      (err as { message?: string })?.message ?? err,
    );
  }
}
