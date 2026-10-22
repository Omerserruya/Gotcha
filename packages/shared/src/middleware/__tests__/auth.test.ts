import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the single authentication gate.
 *
 * These lock in the two security fixes made during the Authentik migration:
 *   1. identity resolution fails CLOSED (it used to call next() on a DB error)
 *   2. an internal service key is compared in constant time, must name a real
 *      tenant, and cannot fall back to an empty tenant scope
 * plus the core contract: a token is only ever as good as the local user its
 * subject resolves to.
 */

// vi.mock is hoisted above module scope, so the doubles it closes over must
// be created with vi.hoisted rather than plain consts.
const {
  prismaMock,
  resolvePrincipalMock,
  readSessionCookieMock,
  resolveFromSessionMock,
  AuthErrorMock,
} = vi.hoisted(() => {
  class AuthErrorMock extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    prismaMock: {
      user: { findUnique: vi.fn() },
      tenant: { findUnique: vi.fn() },
    },
    resolvePrincipalMock: vi.fn(),
    readSessionCookieMock: vi.fn(),
    resolveFromSessionMock: vi.fn(),
    AuthErrorMock,
  };
});

vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/principal", () => ({
  resolvePrincipal: resolvePrincipalMock,
  AuthError: AuthErrorMock,
}));
vi.mock("../../lib/session-principal", () => ({
  readSessionCookie: readSessionCookieMock,
  resolvePrincipalFromSessionToken: resolveFromSessionMock,
}));

import { authenticate } from "../auth";

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function mockReq(headers: Record<string, string> = {}) {
  return { headers } as any;
}

describe("authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    delete process.env.SESSION_COOKIE_ACCEPT;
    delete process.env.COOKIE_ONLY_ENFORCE;
    delete process.env.LEGACY_BEARER_ACCEPT;
    process.env.NODE_ENV = "test";
  });

  it("rejects a request with no bearer token", async () => {
    const res = mockRes();
    const next = vi.fn();
    await authenticate(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("admits a valid token and attaches the resolved principal", async () => {
    resolvePrincipalMock.mockResolvedValue({
      userId: "u1", tenantId: "t1", role: "ADMIN", email: "a@b.com",
    });
    const req = mockReq({ authorization: "Bearer good-token" });
    const res = mockRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.userId).toBe("u1");
    expect(req.tenantId).toBe("t1");
  });

  it("401s an invalid token", async () => {
    resolvePrincipalMock.mockRejectedValue(new AuthErrorMock("Invalid or expired token", "invalid_token"));
    const res = mockRes();
    const next = vi.fn();

    await authenticate(mockReq({ authorization: "Bearer bad" }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a valid identity with no linked GOTCHA account", async () => {
    // Authentication succeeded; authorization does not follow from it.
    resolvePrincipalMock.mockRejectedValue(new AuthErrorMock("No GOTCHA account", "no_account"));
    const res = mockRes();
    const next = vi.fn();

    await authenticate(mockReq({ authorization: "Bearer orphan" }), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s a deactivated account", async () => {
    resolvePrincipalMock.mockRejectedValue(new AuthErrorMock("Account has been deactivated", "inactive"));
    const res = mockRes();
    const next = vi.fn();

    await authenticate(mockReq({ authorization: "Bearer disabled" }), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  // SECURITY REGRESSION GUARD: the old middleware called next() when the
  // lookup threw, so a database blip admitted anyone holding a parseable
  // token - including deactivated users.
  it("fails CLOSED when identity resolution throws unexpectedly", async () => {
    resolvePrincipalMock.mockRejectedValue(new Error("connection terminated"));
    const res = mockRes();
    const next = vi.fn();

    await authenticate(mockReq({ authorization: "Bearer any" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  describe("internal service auth", () => {
    it("admits a correct key that names a real tenant", async () => {
      process.env.INTERNAL_SERVICE_KEY = "s".repeat(40);
      prismaMock.tenant.findUnique.mockResolvedValue({ id: "t9" });

      const req = mockReq({ authorization: `Bearer ${"s".repeat(40)}`, "x-tenant-id": "t9" });
      const res = mockRes();
      const next = vi.fn();

      await authenticate(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tenantId).toBe("t9");
      expect(req.user.isInternal).toBe(true);
      // An internal call must never be verified as a user identity.
      expect(resolvePrincipalMock).not.toHaveBeenCalled();
    });

    // SECURITY REGRESSION GUARD: the old gate did `tenantId || ""`, so a call
    // with no header landed in an empty tenant scope that some queries read as
    // "unscoped".
    it("rejects an internal call with no x-tenant-id", async () => {
      process.env.INTERNAL_SERVICE_KEY = "s".repeat(40);
      const res = mockRes();
      const next = vi.fn();

      await authenticate(mockReq({ authorization: `Bearer ${"s".repeat(40)}` }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("rejects an internal call naming an unknown tenant", async () => {
      process.env.INTERNAL_SERVICE_KEY = "s".repeat(40);
      prismaMock.tenant.findUnique.mockResolvedValue(null);
      const res = mockRes();
      const next = vi.fn();

      await authenticate(
        mockReq({ authorization: `Bearer ${"s".repeat(40)}`, "x-tenant-id": "nope" }),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("refuses a placeholder internal key in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.INTERNAL_SERVICE_KEY = "change-me";
      const res = mockRes();
      const next = vi.fn();

      await authenticate(
        mockReq({ authorization: "Bearer change-me", "x-tenant-id": "t1" }),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      process.env.NODE_ENV = "test";
    });

    // PROD REGRESSION GUARD (2026-08-19): a weak 24-char legacy
    // INTERNAL_SERVICE_TOKEN sat next to the strong KEY in two services, and
    // the weakness check ran over the whole list - so EVERY internal call
    // threw, including callers presenting the strong key. All conversation→ai
    // bridge calls 401'd in production. The check must judge only the secret
    // that matched.
    it("a weak secondary secret does not poison the strong one (production)", async () => {
      process.env.NODE_ENV = "production";
      process.env.INTERNAL_SERVICE_KEY = "s".repeat(64);
      process.env.INTERNAL_SERVICE_TOKEN = "short-legacy-token";
      prismaMock.tenant.findUnique.mockResolvedValue({ id: "t9" });
      const res = mockRes();
      const next = vi.fn();

      await authenticate(
        mockReq({ authorization: `Bearer ${"s".repeat(64)}`, "x-tenant-id": "t9" }),
        res,
        next,
      );

      expect(next).toHaveBeenCalled();
      process.env.NODE_ENV = "test";
      delete process.env.INTERNAL_SERVICE_TOKEN;
    });

    it("still refuses when the weak secret itself is the one presented (production)", async () => {
      process.env.NODE_ENV = "production";
      process.env.INTERNAL_SERVICE_KEY = "s".repeat(64);
      process.env.INTERNAL_SERVICE_TOKEN = "short-legacy-token";
      const res = mockRes();
      const next = vi.fn();

      await authenticate(
        mockReq({ authorization: "Bearer short-legacy-token", "x-tenant-id": "t9" }),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      process.env.NODE_ENV = "test";
      delete process.env.INTERNAL_SERVICE_TOKEN;
    });

    it("falls through to user auth when the key does not match", async () => {
      process.env.INTERNAL_SERVICE_KEY = "s".repeat(40);
      resolvePrincipalMock.mockResolvedValue({
        userId: "u1", tenantId: "t1", role: "AGENT", email: "a@b.com",
      });

      const req = mockReq({ authorization: "Bearer not-the-key", "x-tenant-id": "t-evil" });
      const res = mockRes();
      const next = vi.fn();

      await authenticate(req, res, next);

      expect(next).toHaveBeenCalled();
      // The caller-supplied tenant header must be ignored for user tokens -
      // tenancy comes from the database, never from the request.
      expect(req.tenantId).toBe("t1");
    });
  });
});

/**
 * The cookie door (SESSION_COOKIE_ACCEPT).
 *
 * The gate now has three credentials to reason about, and the dangerous
 * mistakes are all about ORDER and FALL-THROUGH:
 *   - a revoked session must not be rescued by a stale token in the same tab;
 *   - turning browsers cookie-only must not sever service-to-service calls;
 *   - and with the flag off, none of this exists.
 */
describe("authenticate · session cookie", () => {
  const SESSION = "s".repeat(43);

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    delete process.env.SESSION_COOKIE_ACCEPT;
    delete process.env.COOKIE_ONLY_ENFORCE;
    delete process.env.LEGACY_BEARER_ACCEPT;
    process.env.NODE_ENV = "test";
  });

  it("is entirely inert while the flag is off", async () => {
    readSessionCookieMock.mockReturnValue(SESSION);
    const res = mockRes();
    const next = vi.fn();

    await authenticate(mockReq({ cookie: `gotcha_session_dev=${SESSION}` }), res, next);

    // Not even read: a deployment that has not opted in behaves exactly as before.
    expect(readSessionCookieMock).not.toHaveBeenCalled();
    expect(resolveFromSessionMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("admits a live session with no Authorization header at all", async () => {
    process.env.SESSION_COOKIE_ACCEPT = "true";
    readSessionCookieMock.mockReturnValue(SESSION);
    resolveFromSessionMock.mockResolvedValue({
      userId: "u1", tenantId: "t1", role: "ADMIN", email: "a@b.com",
    });
    const req = mockReq({ cookie: `gotcha_session_dev=${SESSION}` });
    const res = mockRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.tenantId).toBe("t1");
    // The browser never had to produce a bearer.
    expect(resolvePrincipalMock).not.toHaveBeenCalled();
  });

  it("passes the tenant hint through to the session resolver", async () => {
    process.env.SESSION_COOKIE_ACCEPT = "true";
    readSessionCookieMock.mockReturnValue(SESSION);
    resolveFromSessionMock.mockResolvedValue({ userId: "u1", tenantId: "t2", role: "AGENT", email: "a@b.com" });

    await authenticate(
      mockReq({ cookie: "x", "x-tenant-id": "t2" }),
      mockRes(),
      vi.fn(),
    );

    expect(resolveFromSessionMock).toHaveBeenCalledWith(SESSION, "t2");
  });

  it("prefers the cookie over a bearer the same request also carries", async () => {
    // The revocable credential wins over the one the server cannot withdraw.
    process.env.SESSION_COOKIE_ACCEPT = "true";
    readSessionCookieMock.mockReturnValue(SESSION);
    resolveFromSessionMock.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "ADMIN", email: "a@b.com" });

    const next = vi.fn();
    await authenticate(mockReq({ cookie: "x", authorization: "Bearer stale" }), mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(resolvePrincipalMock).not.toHaveBeenCalled();
  });

  // SECURITY: the whole point of a revocable session is that revoking it ends
  // access. Falling through to Bearer here would mean a signed-out operator
  // keeps working for as long as the token in their tab stays valid.
  it("does NOT fall through to bearer when a presented session is invalid", async () => {
    process.env.SESSION_COOKIE_ACCEPT = "true";
    readSessionCookieMock.mockReturnValue(SESSION);
    resolveFromSessionMock.mockRejectedValue(new AuthErrorMock("Session is no longer valid", "invalid_token"));
    const res = mockRes();
    const next = vi.fn();

    await authenticate(mockReq({ cookie: "x", authorization: "Bearer still-valid" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(resolvePrincipalMock).not.toHaveBeenCalled();
  });

  it("falls through to bearer when no cookie was presented", async () => {
    process.env.SESSION_COOKIE_ACCEPT = "true";
    readSessionCookieMock.mockReturnValue(null);
    resolvePrincipalMock.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "ADMIN", email: "a@b.com" });
    const next = vi.fn();

    await authenticate(mockReq({ authorization: "Bearer good" }), mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(resolvePrincipalMock).toHaveBeenCalled();
  });

  it("fails CLOSED when the session lookup throws unexpectedly", async () => {
    process.env.SESSION_COOKIE_ACCEPT = "true";
    readSessionCookieMock.mockReturnValue(SESSION);
    resolveFromSessionMock.mockRejectedValue(new Error("connection terminated"));
    const res = mockRes();
    const next = vi.fn();

    await authenticate(mockReq({ cookie: "x" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  describe("cookie-only enforcement", () => {
    it("refuses a browser bearer once COOKIE_ONLY_ENFORCE is set", async () => {
      process.env.SESSION_COOKIE_ACCEPT = "true";
      process.env.COOKIE_ONLY_ENFORCE = "true";
      readSessionCookieMock.mockReturnValue(null);
      const res = mockRes();
      const next = vi.fn();

      await authenticate(mockReq({ authorization: "Bearer perfectly-valid" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "cookie_required" }));
      // Refused on policy, so it is never even verified.
      expect(resolvePrincipalMock).not.toHaveBeenCalled();
    });

    it("refuses a browser bearer when LEGACY_BEARER_ACCEPT is turned off", async () => {
      process.env.LEGACY_BEARER_ACCEPT = "false";
      readSessionCookieMock.mockReturnValue(null);
      const res = mockRes();
      const next = vi.fn();

      await authenticate(mockReq({ authorization: "Bearer perfectly-valid" }), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(resolvePrincipalMock).not.toHaveBeenCalled();
    });

    // The flags govern BROWSER credentials. Services authenticate with a shared
    // secret and have no cookie jar; locking browsers down must not take the
    // platform's own plumbing with it.
    it("still admits internal service calls under cookie-only enforcement", async () => {
      process.env.SESSION_COOKIE_ACCEPT = "true";
      process.env.COOKIE_ONLY_ENFORCE = "true";
      process.env.LEGACY_BEARER_ACCEPT = "false";
      process.env.INTERNAL_SERVICE_KEY = "s".repeat(40);
      prismaMock.tenant.findUnique.mockResolvedValue({ id: "t9" });
      readSessionCookieMock.mockReturnValue(null);

      const req = mockReq({ authorization: `Bearer ${"s".repeat(40)}`, "x-tenant-id": "t9" });
      const next = vi.fn();

      await authenticate(req, mockRes(), next);

      expect(next).toHaveBeenCalled();
      expect(req.user.isInternal).toBe(true);
    });
  });
});
