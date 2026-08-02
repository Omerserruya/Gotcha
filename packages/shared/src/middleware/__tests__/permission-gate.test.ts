import { describe, it, expect, vi, beforeEach } from "vitest";

// The gate resolves through the DB-backed permission resolver; mock it so this
// is a pure unit test of the gate's authz branches (401/403/next/role-fallback).
const hasPermission = vi.fn();
vi.mock("../../lib/permissions", () => ({ hasPermission: (...a: any[]) => hasPermission(...a) }));

import { requirePermission, requirePermissionOrRole } from "../permission-gate";

function ctx(user: any) {
  const req: any = { user, tenantId: user?.tenantId };
  let code = 0; let body: any = null;
  const res: any = { status: (c: number) => { code = c; return res; }, json: (b: any) => { body = b; return res; } };
  const next = vi.fn();
  return { req, res, next, out: () => ({ code, body, nexted: next.mock.calls.length > 0 }) };
}
const ADMIN = { userId: "u1", tenantId: "t1", role: "ADMIN" };
const AGENT = { userId: "u2", tenantId: "t1", role: "AGENT" };

beforeEach(() => hasPermission.mockReset());

describe("requirePermissionOrRole (anti-lockout gate)", () => {
  it("401 when unauthenticated", async () => {
    const c = ctx(null);
    await requirePermissionOrRole("ai:workflows:update", "ADMIN")(c.req, c.res, c.next);
    expect(c.out().code).toBe(401);
    expect(c.out().nexted).toBe(false);
  });

  it("passes a non-admin who HAS the permission", async () => {
    hasPermission.mockResolvedValue(true);
    const c = ctx(AGENT);
    await requirePermissionOrRole("ai:tools:manage", "ADMIN")(c.req, c.res, c.next);
    expect(c.out().nexted).toBe(true);
  });

  it("passes an ADMIN via role fallback even when the permission resolver denies", async () => {
    hasPermission.mockResolvedValue(false); // e.g. tenant not licensed for the domain
    const c = ctx(ADMIN);
    await requirePermissionOrRole("ai:workflows:publish", "ADMIN")(c.req, c.res, c.next);
    expect(c.out().nexted).toBe(true); // never locked out
  });

  it("passes SYSTEM_ADMIN always", async () => {
    hasPermission.mockResolvedValue(false);
    const c = ctx({ userId: "s", tenantId: "t1", role: "SYSTEM_ADMIN" });
    await requirePermissionOrRole("ai:tools:assign", "ADMIN")(c.req, c.res, c.next);
    expect(c.out().nexted).toBe(true);
  });

  it("403 for a non-admin WITHOUT the permission", async () => {
    hasPermission.mockResolvedValue(false);
    const c = ctx(AGENT);
    await requirePermissionOrRole("ai:tools:manage", "ADMIN")(c.req, c.res, c.next);
    expect(c.out().code).toBe(403);
    expect(c.out().body.code).toBe("PERMISSION_DENIED");
    expect(c.out().nexted).toBe(false);
  });

});

describe("requirePermission (OR semantics)", () => {
  it("passes when ANY listed permission is held", async () => {
    hasPermission.mockImplementation(async (_u: any, key: string) => key === "ai:tools:read");
    const c = ctx(AGENT);
    await requirePermission("ai:tools:manage", "ai:tools:read")(c.req, c.res, c.next);
    expect(c.out().nexted).toBe(true);
  });

  it("403 when none are held", async () => {
    hasPermission.mockResolvedValue(false);
    const c = ctx(AGENT);
    await requirePermission("ai:tools:manage")(c.req, c.res, c.next);
    expect(c.out().code).toBe(403);
  });
});
