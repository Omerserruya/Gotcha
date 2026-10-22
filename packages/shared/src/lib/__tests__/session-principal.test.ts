import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The cookie half of identity resolution.
 *
 * What these lock in, in order of how badly each would hurt:
 *   1. Every invalidation mechanism the session model was built with actually
 *      gates access - revocation, hard expiry, and the sessionVersion bump that
 *      means "re-authenticate everywhere". A session store whose revocation is
 *      decorative is worse than a bearer token, because it advertises a
 *      guarantee it does not keep.
 *   2. A tenant hint is validated against memberships and never trusted.
 *   3. A multi-workspace identity with no selection is REFUSED, not guessed at.
 *      Picking one would show an operator another customer's inbox.
 *   4. The provider's sealed access token is never read, so the session
 *      encryption key is not needed to authenticate a request.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    userSession: { findUnique: vi.fn(), update: vi.fn() },
    user: { update: vi.fn() },
    identity: { update: vi.fn() },
  },
}));
vi.mock("../prisma", () => ({ prisma: prismaMock }));

import { resolvePrincipalFromSessionToken, readSessionCookie } from "../session-principal";
import { generateSessionToken } from "../session-token";
import { AuthError } from "../principal";

const NOW = new Date("2026-09-07T10:00:00.000Z");
const FUTURE = new Date("2026-09-08T10:00:00.000Z");
const PAST = new Date("2026-09-06T10:00:00.000Z");

function membership(over: Record<string, unknown> = {}) {
  return {
    id: "usr_1",
    email: "dana@example.com",
    tenantId: "ten_1",
    role: "ADMIN",
    isActive: true,
    lastActiveAt: NOW,
    departmentMembers: [{ departmentId: "dep_1", departmentRole: "MANAGER" }],
    ...over,
  };
}

function session(over: Record<string, unknown> = {}, memberships = [membership()]) {
  return {
    id: "ses_1",
    identityId: "idn_1",
    sessionVersion: 3,
    activeMembershipId: "usr_1",
    revokedAt: null,
    expiresAt: FUTURE,
    // Fresh, so the throttled activity stamp stays quiet unless a test wants it.
    lastActivityAt: NOW,
    identity: { id: "idn_1", sessionVersion: 3, memberships },
    ...over,
  };
}

let token: string;

describe("resolvePrincipalFromSessionToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    token = generateSessionToken();
    prismaMock.userSession.update.mockResolvedValue({});
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.identity.update.mockResolvedValue({});
  });
  afterEach(() => vi.clearAllMocks());

  it("resolves a live session to the membership it acts as", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(session());
    const p = await resolvePrincipalFromSessionToken(token, null, NOW);
    expect(p).toEqual({
      userId: "usr_1",
      identityId: "idn_1",
      tenantId: "ten_1",
      role: "ADMIN",
      email: "dana@example.com",
      departmentId: "dep_1",
      departmentRole: "MANAGER",
    });
  });

  it("looks the session up by HASH, never by the raw cookie value", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(session());
    await resolvePrincipalFromSessionToken(token, null, NOW);
    const where = prismaMock.userSession.findUnique.mock.calls[0][0].where;
    expect(where.sessionTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(where.sessionTokenHash).not.toBe(token);
  });

  it("never selects the sealed provider tokens", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(session());
    await resolvePrincipalFromSessionToken(token, null, NOW);
    const select = prismaMock.userSession.findUnique.mock.calls[0][0].select;
    expect(select.encryptedAccessToken).toBeUndefined();
    expect(select.encryptedRefreshToken).toBeUndefined();
    expect(select.csrfSecret).toBeUndefined();
  });

  // ── The three invalidation mechanisms ────────────────────

  it("refuses a revoked session", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(session({ revokedAt: PAST }));
    await expect(resolvePrincipalFromSessionToken(token, null, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("refuses an expired session", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(session({ expiresAt: PAST }));
    await expect(resolvePrincipalFromSessionToken(token, null, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("refuses a session below the identity's current sessionVersion", async () => {
    // This is the "log out everywhere" path: the identity's version was bumped
    // after a credential reset and every older session must stop working.
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({ sessionVersion: 2, identity: { id: "idn_1", sessionVersion: 3, memberships: [membership()] } }),
    );
    await expect(resolvePrincipalFromSessionToken(token, null, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("gives an unknown session the same answer as a revoked one", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(null);
    const unknown = await resolvePrincipalFromSessionToken(token, null, NOW).catch((e) => e);
    prismaMock.userSession.findUnique.mockResolvedValue(session({ revokedAt: PAST }));
    const revoked = await resolvePrincipalFromSessionToken(token, null, NOW).catch((e) => e);
    // Distinguishing them would confirm which opaque tokens have ever existed.
    expect(unknown.code).toBe(revoked.code);
  });

  it("refuses a malformed token without hashing it", async () => {
    await expect(resolvePrincipalFromSessionToken("not-a-token", null, NOW)).rejects.toBeInstanceOf(AuthError);
    expect(prismaMock.userSession.findUnique).not.toHaveBeenCalled();
  });

  // ── Membership selection ─────────────────────────────────

  it("refuses a hint naming a tenant the identity has no membership in", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(session());
    const err = await resolvePrincipalFromSessionToken(token, "ten_other", NOW).catch((e) => e);
    expect(err.code).toBe("tenant_denied");
  });

  it("reports a hinted-but-deactivated membership as deactivated, not denied", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({}, [membership(), membership({ id: "usr_2", tenantId: "ten_2", isActive: false })]),
    );
    const err = await resolvePrincipalFromSessionToken(token, "ten_2", NOW).catch((e) => e);
    expect(err.code).toBe("inactive");
  });

  it("honours a valid hint over the session's own selection", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({}, [membership(), membership({ id: "usr_2", tenantId: "ten_2" })]),
    );
    const p = await resolvePrincipalFromSessionToken(token, "ten_2", NOW);
    expect(p.tenantId).toBe("ten_2");
  });

  it("falls back to the session's active membership when no hint is sent", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({ activeMembershipId: "usr_2" }, [membership(), membership({ id: "usr_2", tenantId: "ten_2" })]),
    );
    const p = await resolvePrincipalFromSessionToken(token, null, NOW);
    expect(p.tenantId).toBe("ten_2");
  });

  it("ignores an activeMembershipId that has since been deactivated", async () => {
    // SetNull covers a DELETED membership; a merely deactivated one leaves the
    // pointer intact, and following it would admit a revoked operator.
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({ activeMembershipId: "usr_2" }, [
        membership(),
        membership({ id: "usr_2", tenantId: "ten_2", isActive: false }),
      ]),
    );
    const p = await resolvePrincipalFromSessionToken(token, null, NOW);
    expect(p.tenantId).toBe("ten_1"); // the one remaining active membership
  });

  it("refuses to pick a workspace for a multi-membership session that has not chosen", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({ activeMembershipId: null }, [membership(), membership({ id: "usr_2", tenantId: "ten_2" })]),
    );
    const err = await resolvePrincipalFromSessionToken(token, null, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("tenant_denied");
  });

  it("refuses an identity whose every membership is deactivated", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({}, [membership({ isActive: false })]),
    );
    const err = await resolvePrincipalFromSessionToken(token, null, NOW).catch((e) => e);
    expect(err.code).toBe("inactive");
  });

  // ── Activity stamping ────────────────────────────────────

  it("does not write on every request", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(session({ lastActivityAt: NOW }));
    await resolvePrincipalFromSessionToken(token, null, NOW);
    expect(prismaMock.userSession.update).not.toHaveBeenCalled();
  });

  it("refreshes lastActivityAt once the throttle window has passed", async () => {
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({ lastActivityAt: new Date(NOW.getTime() - 10 * 60 * 1000) }),
    );
    await resolvePrincipalFromSessionToken(token, null, NOW);
    expect(prismaMock.userSession.update).toHaveBeenCalledWith({
      where: { id: "ses_1" },
      data: { lastActivityAt: NOW },
    });
  });

  it("still authenticates when the activity write fails", async () => {
    // Instrumentation must never turn a database blip into a logout.
    prismaMock.userSession.findUnique.mockResolvedValue(
      session({ lastActivityAt: new Date(NOW.getTime() - 10 * 60 * 1000) }),
    );
    prismaMock.userSession.update.mockRejectedValue(new Error("connection terminated"));
    await expect(resolvePrincipalFromSessionToken(token, null, NOW)).resolves.toMatchObject({
      tenantId: "ten_1",
    });
  });
});

describe("readSessionCookie", () => {
  const devEnv = { SESSION_COOKIE_SECURE: "false" } as any;

  it("returns null when no cookie header is present", () => {
    expect(readSessionCookie(undefined, devEnv)).toBeNull();
  });

  it("extracts a well-formed token from among other cookies", () => {
    const t = generateSessionToken();
    expect(readSessionCookie(`theme=dark; gotcha_session_dev=${t}; other=1`, devEnv)).toBe(t);
  });

  it("returns null for a value that is not one of our tokens", () => {
    expect(readSessionCookie("gotcha_session_dev=whatever", devEnv)).toBeNull();
  });

  it("returns null when the cookie appears twice", () => {
    // Ambiguity in an auth cookie is a rejection, never "pick the first".
    const t = generateSessionToken();
    expect(readSessionCookie(`gotcha_session_dev=${t}; gotcha_session_dev=${t}`, devEnv)).toBeNull();
  });

  it("reads the __Host- name when the contract is secure", () => {
    const t = generateSessionToken();
    const prodish = { SESSION_COOKIE_SECURE: "true" } as any;
    expect(readSessionCookie(`__Host-gotcha_session=${t}`, prodish)).toBe(t);
    // ...and does not accept the dev cookie under a secure contract.
    expect(readSessionCookie(`gotcha_session_dev=${t}`, prodish)).toBeNull();
  });
});
