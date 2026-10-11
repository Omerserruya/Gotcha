import {
  prisma,
  hasPermission,
  hasFeature,
  isFeature,
  isPermissionKey,
  expandPermissionPattern,
  getEffectiveBuiltinRole,
  type PermissionPrincipal,
} from "@chatcenter/shared";

/**
 * Nobody hands out more than they hold (2026-10-11).
 *
 * Four doors let a workspace admin give away power they did not have: create a
 * custom role holding "*", grant any user any key (billing included), assign
 * the Owner role (to themselves too), and invite anyone into any role. The
 * rule for all four is one sentence: you may grant a set of permissions only if
 * you hold every permission it expands to. "*" and "area:*" expand against the
 * catalog, so a non-owner cannot grant a wildcard. The Owner role is granted,
 * and an Owner's roles changed, by an Owner only.
 *
 * A platform SYSTEM_ADMIN holds everything (hasPermission's own rule).
 */

export interface GrantRefusal {
  status: 403;
  code: "ABOVE_OWN_ROLE" | "OWNER_ONLY";
  error: string;
  /** The keys the actor would be handing out without holding. */
  missing?: string[];
}

export async function isOwnerActor(actor: PermissionPrincipal): Promise<boolean> {
  if (actor.role === "SYSTEM_ADMIN") return true;
  return (await getEffectiveBuiltinRole(actor)) === "owner";
}

/** The permission keys (and tenant features) in `patterns` the actor does not hold. */
export async function keysActorLacks(actor: PermissionPrincipal, patterns: string[]): Promise<string[]> {
  if (actor.role === "SYSTEM_ADMIN") return [];
  const wanted = new Set<string>();
  for (const p of patterns) {
    if (isPermissionKey(p) || p === "*" || p.endsWith(":*")) for (const k of expandPermissionPattern(p)) wanted.add(k);
    else if (isFeature(p)) wanted.add(p);
  }
  const missing: string[] = [];
  for (const key of wanted) {
    const held = isPermissionKey(key) ? await hasPermission(actor, key) : await hasFeature(actor, key as any);
    if (!held) missing.push(key);
  }
  return missing.sort();
}

/** May the actor grant these patterns (a custom role's set, or one grant)? */
export async function patternsRefusal(actor: PermissionPrincipal, patterns: string[]): Promise<GrantRefusal | null> {
  const missing = await keysActorLacks(actor, patterns);
  if (missing.length === 0) return null;
  return { status: 403, code: "ABOVE_OWN_ROLE", error: "You cannot grant permissions you do not have", missing };
}

/** May the actor give someone this role (assign, replace, or invite into it)? */
export async function roleRefusal(actor: PermissionPrincipal, tenantId: string, roleId: string): Promise<GrantRefusal | null> {
  const role = await prisma.tenantRole.findFirst({
    where: { id: roleId, tenantId },
    select: { builtinKey: true, features: { select: { feature: true } } },
  });
  if (!role) return null; // the caller's own not-found answer applies
  if (role.builtinKey === "owner" && !(await isOwnerActor(actor))) {
    return { status: 403, code: "OWNER_ONLY", error: "Only an Owner can make someone an Owner" };
  }
  return patternsRefusal(actor, role.features.map((f) => f.feature));
}

/** May the actor change this person's roles at all? An Owner's, only an Owner. */
export async function targetRefusal(actor: PermissionPrincipal, tenantId: string, targetUserId: string): Promise<GrantRefusal | null> {
  const target = await prisma.user.findFirst({ where: { id: targetUserId, tenantId }, select: { id: true, role: true } });
  if (!target) return null;
  const targetBuiltin = await getEffectiveBuiltinRole({ userId: target.id, tenantId, role: target.role });
  if (targetBuiltin === "owner" && !(await isOwnerActor(actor))) {
    return { status: 403, code: "OWNER_ONLY", error: "Only an Owner can change an Owner's role" };
  }
  return null;
}

/** The principal of the request's own user, for the checks above. */
export function actorOf(req: { user?: any; tenantId?: string }): PermissionPrincipal {
  const u = req.user ?? {};
  return { userId: u.userId, tenantId: req.tenantId ?? u.tenantId, role: u.role, departmentRole: u.departmentRole ?? null };
}

/**
 * May the actor invite someone into this resolved invite role? The same rule
 * as assigning it: an invitation is an assignment that waits for a click.
 */
export async function inviteRoleRefusal(
  actor: PermissionPrincipal,
  tenantId: string,
  resolved: { tenantRoleId: string | null },
): Promise<GrantRefusal | null> {
  return resolved.tenantRoleId ? roleRefusal(actor, tenantId, resolved.tenantRoleId) : null;
}
