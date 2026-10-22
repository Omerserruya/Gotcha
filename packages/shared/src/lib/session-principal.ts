/**
 * Turn the opaque session cookie into a GOTCHA principal.
 *
 * The cookie half of `resolvePrincipal`. Both funnel into the same JwtPayload,
 * so a route cannot tell (and must not care) which front door a caller used.
 *
 * WHY THIS DOES NOT DECRYPT THE SESSION'S ACCESS TOKEN
 * ----------------------------------------------------
 * UserSession seals the provider's access/refresh tokens so the platform can
 * call Authentik ON THE USER'S BEHALF. They are NOT the evidence for our own
 * authentication, and reading them here would be both unnecessary and worse:
 *
 *   - Unnecessary, because the only thing `resolvePrincipal` extracts from an
 *     access token is `sub`, which it maps back to an Identity. The session row
 *     already NAMES the identity (`identityId`) and the membership it acts as
 *     (`activeMembershipId`). Decrypting a token to rediscover a foreign key we
 *     are already holding is a round trip to nowhere.
 *   - Worse, because unsealing needs SESSION_ENCRYPTION_KEY, which today lives
 *     only in the auth service. Making every service able to read a session
 *     would mean copying that key into all nine of them, so a bug anywhere
 *     could surrender every user's provider tokens. The blast radius of the
 *     session key stays exactly where it is.
 *
 * What replaces the token's `exp` is stronger, not weaker: a server-side
 * session is revocable. `isSessionUsable` enforces all three of the
 * invalidation mechanisms the model was built with - explicit revocation
 * (`revokedAt`), hard expiry (`expiresAt`), and global re-authentication
 * (`sessionVersion` below the identity's current version). A bearer token can
 * do none of that; once minted it is valid until it expires, wherever it has
 * been copied to.
 *
 * ENTIRELY GATED by SESSION_COOKIE_ACCEPT. With the flag off (the default) no
 * caller reaches this file and Bearer authentication is untouched.
 */
import { prisma } from "./prisma";
import { AuthError } from "./principal";
import { parseSessionCookie, resolveSessionCookieContract, SessionCookieError } from "./session-cookie";
import { hashSessionToken, isWellFormedSessionToken } from "./session-token";
import { isSessionUsable } from "./session-store";
import type { JwtPayload } from "./jwt";

/** Stamp session.lastActivityAt / membership.lastActiveAt at most this often. */
const ACTIVITY_STAMP_INTERVAL_MS = 5 * 60 * 1000;

const membershipSelect = {
  id: true,
  email: true,
  tenantId: true,
  role: true,
  isActive: true,
  lastActiveAt: true,
  // The principal carries the PRIMARY (earliest) department, matching
  // resolvePrincipal exactly - the two front doors must not disagree about
  // what a caller's department scope is.
  departmentMembers: {
    select: { departmentId: true, departmentRole: true },
    orderBy: { createdAt: "asc" as const },
    take: 1,
  },
} as const;

/**
 * Read the session cookie out of a raw Cookie header.
 *
 * Returns null when there is simply no session cookie - that is "this caller
 * did not present one", not a failure, and the caller falls through to Bearer.
 * A MALFORMED or duplicated cookie is null too: `parseSessionCookie` treats
 * ambiguity as a rejection, and an ambiguous auth cookie must not be guessed at.
 */
export function readSessionCookie(
  cookieHeader: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let raw: string | null;
  try {
    raw = parseSessionCookie(cookieHeader, resolveSessionCookieContract(env).name);
  } catch (err) {
    if (err instanceof SessionCookieError) return null;
    throw err;
  }
  // Shape-check before hashing: `hashSessionToken` refuses arbitrary input, and
  // a 401 is the right answer for a value that was never one of our tokens.
  return raw !== null && isWellFormedSessionToken(raw) ? raw : null;
}

/**
 * Resolve an opaque session token to the principal it authenticates.
 *
 * Membership selection mirrors resolvePrincipal, with one addition: the session
 * itself remembers which membership it is acting as, so a multi-workspace
 * identity does not have to re-send a hint on every request.
 *   1. `tenantHint` (X-Tenant-Id) - validated against the identity's active
 *      memberships, NEVER trusted as-is.
 *   2. The session's own `activeMembershipId`, if it is still active.
 *   3. Exactly one active membership - that one.
 *   4. Otherwise: no selection has been made. Throwing here is deliberate; the
 *      tenant picker must run rather than the server picking a workspace for
 *      someone and showing them another customer's inbox.
 *
 * Throws AuthError on every failure. There is no partial success.
 */
export async function resolvePrincipalFromSessionToken(
  rawToken: string,
  tenantHint?: string | null,
  now: Date = new Date(),
): Promise<JwtPayload> {
  if (!isWellFormedSessionToken(rawToken)) {
    throw new AuthError("Invalid session", "invalid_token");
  }

  const session = await prisma.userSession.findUnique({
    where: { sessionTokenHash: hashSessionToken(rawToken) },
    select: {
      id: true,
      identityId: true,
      sessionVersion: true,
      activeMembershipId: true,
      revokedAt: true,
      expiresAt: true,
      lastActivityAt: true,
      identity: {
        select: {
          id: true,
          sessionVersion: true,
          memberships: { select: membershipSelect },
        },
      },
    },
  });

  // An unknown hash and a revoked session are the same answer to the caller.
  // Distinguishing them would confirm which opaque tokens have ever existed.
  if (!session) throw new AuthError("Invalid session", "invalid_token");

  if (!isSessionUsable(session, session.identity.sessionVersion, now)) {
    throw new AuthError("Session is no longer valid", "invalid_token");
  }

  const active = session.identity.memberships.filter((m) => m.isActive);
  if (active.length === 0) {
    throw new AuthError("Account has been deactivated", "inactive");
  }

  let membership: (typeof active)[number] | undefined;
  if (tenantHint) {
    membership = active.find((m) => m.tenantId === tenantHint);
    if (!membership) {
      const disabled = session.identity.memberships.some(
        (m) => m.tenantId === tenantHint && !m.isActive,
      );
      throw disabled
        ? new AuthError("Account has been deactivated", "inactive")
        : new AuthError("No membership in the requested tenant", "tenant_denied");
    }
  } else if (session.activeMembershipId) {
    // SetNull on membership delete already blanks this, but a membership that
    // was merely DEACTIVATED leaves the id in place - so re-check isActive
    // rather than trusting the pointer.
    membership = active.find((m) => m.id === session.activeMembershipId);
  }
  if (!membership && active.length === 1) membership = active[0];
  if (!membership) {
    throw new AuthError("No workspace selected for this session", "tenant_denied");
  }

  // Activity keeps the idle timeout meaningful: a session that is being used
  // should not expire out from under an active operator. Throttled and
  // fire-and-forget - tracking must never add latency to every request, and a
  // database blip must never turn a valid session into a 401.
  const stale =
    now.getTime() - session.lastActivityAt.getTime() > ACTIVITY_STAMP_INTERVAL_MS;
  if (stale) {
    const membershipId = membership.id;
    void Promise.all([
      prisma.userSession.update({ where: { id: session.id }, data: { lastActivityAt: now } }),
      prisma.user.update({ where: { id: membershipId }, data: { lastActiveAt: now } }),
      prisma.identity.update({
        where: { id: session.identity.id },
        data: { lastTenantId: membership.tenantId },
      }),
    ]).catch(() => {});
  }

  return {
    userId: membership.id,
    identityId: session.identity.id,
    tenantId: membership.tenantId,
    role: membership.role,
    email: membership.email,
    departmentId: membership.departmentMembers?.[0]?.departmentId,
    departmentRole: membership.departmentMembers?.[0]?.departmentRole,
  };
}
