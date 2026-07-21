import { verifyAccessToken } from "./jwt";
import { prisma } from "./prisma";
import type { JwtPayload } from "./jwt";

/**
 * Turn an Authentik access token into a GOTCHA principal.
 *
 * This is the one place where "Authentik says this is subject X" becomes
 * "GOTCHA says this is membership U, in tenant T, with role R". HTTP requests
 * (middleware/auth.ts) and WebSocket handshakes (conversation + notifications)
 * all funnel through it, so there is a single definition of who a caller is
 * and a single set of rules for rejecting them.
 *
 * Multi-tenant identity: the subject resolves to an Identity, which owns one
 * MEMBERSHIP (User row) per tenant. Which membership becomes the principal:
 *   1. `tenantHint` (the X-Tenant-Id header / ws auth payload) - validated
 *      against the identity's memberships, NEVER trusted as-is. A hint naming
 *      a tenant the identity has no active membership in is rejected.
 *   2. No hint, one membership - that one (the pre-membership behavior, so
 *      every existing single-tenant caller works unchanged without a header).
 *   3. No hint, many memberships - the identity's last used tenant, falling
 *      back to the most recently active membership. API calls keep working;
 *      the frontend always sends the hint after tenant selection.
 *
 * Throws on every failure; there is no partial success. Callers must map a
 * throw to a rejection and never continue.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_token" | "no_account" | "inactive" | "tenant_denied",
  ) {
    super(message);
  }
}

/** Stamp membership.lastActiveAt / identity.lastTenantId at most this often. */
const ACTIVITY_STAMP_INTERVAL_MS = 5 * 60 * 1000;

const membershipSelect = {
  id: true,
  email: true,
  tenantId: true,
  role: true,
  isActive: true,
  lastActiveAt: true,
  departmentMember: { select: { departmentId: true, departmentRole: true } },
} as const;

export async function resolvePrincipal(token: string, tenantHint?: string | null): Promise<JwtPayload> {
  const verified = await verifyAccessToken(token).catch(() => {
    throw new AuthError("Invalid or expired token", "invalid_token");
  });

  const identity = await prisma.identity.findUnique({
    where: { authentikSubject: verified.subject },
    select: {
      id: true,
      lastTenantId: true,
      memberships: { select: membershipSelect },
    },
  });

  if (!identity || identity.memberships.length === 0) {
    throw new AuthError("No GOTCHA account is linked to this identity", "no_account");
  }

  const active = identity.memberships.filter((m) => m.isActive);
  if (active.length === 0) {
    throw new AuthError("Account has been deactivated", "inactive");
  }

  let membership;
  if (tenantHint) {
    membership = active.find((m) => m.tenantId === tenantHint);
    if (!membership) {
      // The hinted tenant exists as a DISABLED membership → same signal as a
      // deactivated account; unknown tenant → the caller has no business there.
      const disabled = identity.memberships.some((m) => m.tenantId === tenantHint && !m.isActive);
      throw disabled
        ? new AuthError("Account has been deactivated", "inactive")
        : new AuthError("No membership in the requested tenant", "tenant_denied");
    }
  } else if (active.length === 1) {
    membership = active[0];
  } else {
    membership =
      active.find((m) => m.tenantId === identity.lastTenantId) ??
      [...active].sort(
        (a, b) => (b.lastActiveAt?.getTime() ?? 0) - (a.lastActiveAt?.getTime() ?? 0),
      )[0];
  }

  // Keep "last used" fresh for the tenant picker / hint-less resolution.
  // Throttled and fire-and-forget: activity tracking must never add latency
  // or turn a DB blip into an auth failure.
  const now = Date.now();
  const stale =
    !membership.lastActiveAt || now - membership.lastActiveAt.getTime() > ACTIVITY_STAMP_INTERVAL_MS;
  if (stale) {
    const stampedAt = new Date(now);
    void Promise.all([
      prisma.user.update({ where: { id: membership.id }, data: { lastActiveAt: stampedAt } }),
      prisma.identity.update({ where: { id: identity.id }, data: { lastTenantId: membership.tenantId } }),
    ]).catch(() => {});
  }

  return {
    userId: membership.id,
    identityId: identity.id,
    tenantId: membership.tenantId,
    role: membership.role,
    email: membership.email,
    departmentId: membership.departmentMember?.departmentId,
    departmentRole: membership.departmentMember?.departmentRole,
  };
}
