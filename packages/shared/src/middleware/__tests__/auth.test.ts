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
const { prismaMock, resolvePrincipalMock, AuthErrorMock } = vi.hoisted(() => {
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
    AuthErrorMock,
  };
});

vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/principal", () => ({
  resolvePrincipal: resolvePrincipalMock,
  AuthError: AuthErrorMock,
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
