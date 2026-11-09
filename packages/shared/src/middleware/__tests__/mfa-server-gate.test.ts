/**
 * Prod 2026-11-09: a new SYSTEM_ADMIN used the console with no MFA. The MFA
 * check ran on two routers only. Now authenticate() itself refuses a human
 * whose MFA is required and not enrolled, on every route but the few needed to
 * enrol and leave. Run through authenticate(): removing the gate there makes
 * the sysadmin's call succeed and this suite fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, resolvePrincipalMock, AuthErrorMock, idp } = vi.hoisted(() => {
  class AuthErrorMock extends Error { code: string; constructor(m: string, c: string) { super(m); this.code = c; } }
  return {
    prismaMock: { user: { findUnique: vi.fn() }, identity: { update: vi.fn(async () => ({})) }, tenant: { findUnique: vi.fn() } },
    resolvePrincipalMock: vi.fn(),
    AuthErrorMock,
    idp: { devices: { totp: [] as any[], passkeys: [] as any[], recoveryCodes: [] as any[] }, fail: false, calls: 0 },
  };
});

vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/principal", () => ({ resolvePrincipal: resolvePrincipalMock, AuthError: AuthErrorMock }));
vi.mock("../../lib/session-principal", () => ({ readSessionCookie: vi.fn(() => null), resolvePrincipalFromSessionToken: vi.fn() }));
vi.mock("../../lib/authentik", () => ({
  findIdentityBySubject: vi.fn(async () => ({ pk: 7, username: "admin2" })),
  listUserDevices: vi.fn(async () => { idp.calls++; if (idp.fail) throw new Error("authentik 503"); return idp.devices; }),
}));

import { authenticate } from "../auth";
import { mfaGateExempt, resetMfaGateCache, observeMfaRequirement } from "../mfa-server-gate";

const res = () => { const r: any = {}; r.status = vi.fn(() => r); r.json = vi.fn(() => r); return r; };
const call = async (method: string, url: string) => {
  const req: any = { method, originalUrl: url, url, headers: { authorization: "Bearer tok" } };
  const r = res(); const next = vi.fn();
  await authenticate(req, r, next);
  return { passed: next.mock.calls.length === 1, status: r.status.mock.calls[0]?.[0] ?? null, body: r.json.mock.calls[0]?.[0] ?? null };
};
const user = (role: string, stamp: Date | null, policy = { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: false }) =>
  prismaMock.user.findUnique.mockResolvedValue({ role, identityId: "id1", identity: { mfaEnrolledAt: stamp, authentikSubject: "sub1" }, tenant: policy });

beforeEach(() => {
  vi.clearAllMocks();
  resetMfaGateCache();
  for (const k of ["INTERNAL_SERVICE_KEY", "INTERNAL_SERVICE_TOKEN", "SESSION_COOKIE_ACCEPT", "COOKIE_ONLY_ENFORCE", "LEGACY_BEARER_ACCEPT", "MFA_SERVER_GATE", "AUTHENTIK_URL", "AUTHENTIK_API_TOKEN", "AUTHENTIK_BOOTSTRAP_TOKEN"]) delete process.env[k];
  process.env.NODE_ENV = "test";
  resolvePrincipalMock.mockResolvedValue({ userId: "u_admin2", tenantId: "t_sys", role: "SYSTEM_ADMIN", email: "admin2@x" });
  idp.devices = { totp: [], passkeys: [], recoveryCodes: [] }; idp.fail = false; idp.calls = 0;
});

describe("a SYSTEM_ADMIN with no MFA", () => {
  it("★ a system route: 403 mfa_enrollment_required (reason system_admin), never reached", async () => {
    user("SYSTEM_ADMIN", null);
    const r = await call("GET", "/api/system/tenants");
    expect(r).toEqual({ passed: false, status: 403, body: { error: "mfa_enrollment_required", reason: "system_admin" } });
  });
  it("can still reach enrolment, the gate's own read, /me and logout", async () => {
    user("SYSTEM_ADMIN", null);
    for (const [m, u] of [["GET", "/api/account/mfa-gate"], ["GET", "/api/account/security"], ["DELETE", "/api/account/security/device/totp/3"], ["GET", "/api/account"], ["GET", "/api/auth/me"], ["GET", "/api/auth/me/memberships"], ["POST", "/api/auth/logout"]]) {
      expect((await call(m, u)).passed, `${m} ${u}`).toBe(true);
    }
    // ...but not the rest of the account, nor a look-alike path.
    expect((await call("PATCH", "/api/account")).status).toBe(403);
    expect((await call("GET", "/api/account/sessions")).status).toBe(403);
    expect((await call("GET", "/api/auth/me-and-more")).status).toBe(403);
    expect((await call("GET", "/api/system/x?next=/api/auth/me")).status).toBe(403);
  });
  it("enrolled (stamped): the route works", async () => {
    user("SYSTEM_ADMIN", new Date());
    expect((await call("GET", "/api/system/tenants")).passed).toBe(true);
  });
});

describe("the live check (where Authentik is reachable: the auth service)", () => {
  beforeEach(() => { process.env.AUTHENTIK_URL = "http://authentik"; process.env.AUTHENTIK_API_TOKEN = "t"; });
  it("just enrolled (authenticator + recovery codes): let in and stamped", async () => {
    user("SYSTEM_ADMIN", null);
    idp.devices = { totp: [{}], passkeys: [], recoveryCodes: [{}] };
    expect((await call("GET", "/api/system/tenants")).passed).toBe(true);
    expect(prismaMock.identity.update).toHaveBeenCalledWith({ where: { id: "id1" }, data: { mfaEnrolledAt: expect.any(Date) } });
  });
  it("an authenticator without recovery codes is not enrolled; an Authentik error never lets them in", async () => {
    user("SYSTEM_ADMIN", null);
    idp.devices = { totp: [{}], passkeys: [], recoveryCodes: [] };
    expect((await call("GET", "/api/system/tenants")).status).toBe(403);
    resetMfaGateCache();
    idp.fail = true;
    expect((await call("GET", "/api/system/tenants")).status).toBe(403);
  });
});

describe("who else", () => {
  it("an ADMIN: gated only when the workspace requires it; an AGENT only when all users must", async () => {
    user("ADMIN", null);
    expect((await call("GET", "/api/conversations")).passed).toBe(true);
    resetMfaGateCache();
    user("ADMIN", null, { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: false });
    expect((await call("GET", "/api/conversations")).body).toEqual({ error: "mfa_enrollment_required", reason: "tenant_admins" });
    resetMfaGateCache();
    user("AGENT", null, { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: false });
    expect((await call("GET", "/api/conversations")).passed).toBe(true);
    resetMfaGateCache();
    user("AGENT", null, { mfaRequiredForAdmins: false, mfaRequiredForAllUsers: true });
    expect((await call("GET", "/api/conversations")).status).toBe(403);
  });
  it("an internal service call is never gated; MFA_SERVER_GATE=off lets everyone through", async () => {
    process.env.INTERNAL_SERVICE_KEY = "k".repeat(40);
    prismaMock.tenant.findUnique.mockResolvedValue({ id: "t1" });
    user("SYSTEM_ADMIN", null);
    const req: any = { method: "GET", originalUrl: "/api/system/x", url: "/api/system/x", headers: { authorization: `Bearer ${"k".repeat(40)}`, "x-tenant-id": "t1" } };
    const next = vi.fn(); await authenticate(req, res(), next);
    expect(next).toHaveBeenCalled();
    delete process.env.INTERNAL_SERVICE_KEY;
    process.env.MFA_SERVER_GATE = "off";
    expect((await call("GET", "/api/system/tenants")).passed).toBe(true);
  });
  it("exempt paths are exact", () => {
    expect(mfaGateExempt("GET", "/api/account/security/")).toBe(true);
    expect(mfaGateExempt("POST", "/api/account")).toBe(false);
    expect(mfaGateExempt("GET", "/api/accounts")).toBe(false);
  });
});

describe("Authentik's marker hears every verdict (Option B)", () => {
  it("the observer is told the identity, for a required and a not-required user alike", async () => {
    const seen: string[] = [];
    observeMfaRequirement((id) => seen.push(id));
    user("SYSTEM_ADMIN", null);
    await call("GET", "/api/system/tenants");
    resetMfaGateCache();
    user("AGENT", null);
    await call("GET", "/api/conversations");
    observeMfaRequirement(null);
    expect(seen).toEqual(["id1", "id1"]);
  });
});
