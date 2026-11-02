/**
 * Support mode on the v2 BFF's front door (2026-11-02): Bearer <Authentik
 * access token> + x-tenant-id + x-support-session. Prod found that only the
 * cookie path honoured support mode, so the BFF's start got 400 and its calls
 * would have resolved as the admin's own tenant.
 *   - a Bearer principal carries its login as sessionId = "oidc:<sid>"
 *   - support mode on Bearer: the tenant's ADMIN, the deny table, the audit context
 *   - a token from another login (another sid), or with no sid, is refused
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({ sessions: new Map<string, any>(), users: new Map<string, any>(), sid: "sid-A" as string | undefined, ctx: null as any }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    supportSession: { findUnique: async ({ where }: any) => DB.sessions.get(where.id) ?? null },
    user: { findFirst: async ({ where }: any) => [...DB.users.values()].find((u) => u.id === where.id && u.tenantId === where.tenantId && u.kind === where.kind) ?? null },
    auditLog: { create: async ({ data }: any) => data },
  },
  withCrossTenantAccess: (fn: any) => fn(),
}));
vi.mock("../lib/session-principal", () => ({ readSessionCookie: () => null, resolvePrincipalFromSessionToken: async () => { throw new Error("no cookie"); } }));
vi.mock("../lib/session-flags", () => ({ readSessionFlags: () => ({ cookieAccept: true, cookieOnlyEnforce: false, legacyBearerAccept: true }) }));
vi.mock("../lib/principal", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    // The real resolvePrincipal, past JWKS: the admin's System membership, with the token's sid.
    resolvePrincipal: async (_token: string, hint: string | null) => {
      if (hint && hint !== "t_system") throw new actual.AuthError("No membership in the requested tenant", "tenant_denied");
      return { userId: "u_sys", identityId: "id_admin", tenantId: "t_system", role: "SYSTEM_ADMIN", email: "omer@gotcha.co.il", ...(DB.sid ? { sessionId: `oidc:${DB.sid}` } : {}) };
    },
  };
});

import { authenticate } from "../middleware/auth";
import { currentRequestContext } from "../lib/request-context";

const HOUR = 3_600_000;
beforeEach(() => {
  DB.sessions.clear(); DB.users.clear(); DB.sid = "sid-A"; DB.ctx = null;
  DB.users.set("u_support", { id: "u_support", tenantId: "t_shop", kind: "support", email: "support@gotcha.internal" });
  DB.sessions.set("ss_1", { id: "ss_1", tenantId: "t_shop", adminUserId: "u_sys", userSessionId: "oidc:sid-A", supportUserId: "u_support", reason: "r", startedAt: new Date(), expiresAt: new Date(Date.now() + 2 * HOUR), endedAt: null });
});

const run = async (headers: Record<string, string>, method = "GET", url = "/api/conversations") => {
  const req: any = { headers: { authorization: "Bearer at-token", ...headers }, method, originalUrl: url, url, body: {} };
  const res: any = { code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
  let nexted = false;
  await authenticate(req, res, () => { nexted = true; DB.ctx = currentRequestContext(); });
  return { req, res, nexted };
};
const SUPPORT = { "x-support-session": "ss_1", "x-tenant-id": "t_shop" };

describe("support mode through the BFF's Bearer", () => {
  it("the tenant's ADMIN as the support actor, with the support audit context", async () => {
    const { req, nexted } = await run(SUPPORT);
    expect(nexted).toBe(true);
    expect(req.tenantId).toBe("t_shop");
    expect(req.user).toMatchObject({ userId: "u_support", role: "ADMIN", support: { sessionId: "ss_1", adminUserId: "u_sys" } });
    expect(DB.ctx).toMatchObject({ supportSessionId: "ss_1", supportAdminUserId: "u_sys" });
  });

  it("the deny table applies on Bearer too", async () => {
    const { res, nexted } = await run(SUPPORT, "DELETE", "/api/conversations/c1");
    expect(nexted).toBe(false);
    expect([res.code, res.body.code]).toEqual([403, "support_denied:delete"]);
  });

  it("a token from another login (another sid): refused, never the admin's own tenant", async () => {
    DB.sid = "sid-B";
    const { res, nexted } = await run(SUPPORT);
    expect(nexted).toBe(false);
    expect([res.code, res.body.code]).toEqual([401, "support_session_invalid"]);
  });

  it("a token with no sid cannot be in support mode", async () => {
    DB.sid = undefined;
    const { res, nexted } = await run(SUPPORT);
    expect(nexted).toBe(false);
    expect(res.body.code).toBe("support_session_invalid");
  });

  it("an ended session: 401 support_expired", async () => {
    DB.sessions.get("ss_1").endedAt = new Date();
    const { res } = await run(SUPPORT);
    expect([res.code, res.body.code]).toEqual([401, "support_expired"]);
  });

  it("without the support header the Bearer path is unchanged: membership only", async () => {
    const own = await run({});
    expect(own.req.user).toMatchObject({ tenantId: "t_system", role: "SYSTEM_ADMIN", sessionId: "oidc:sid-A" });
    const foreign = await run({ "x-tenant-id": "t_shop" });
    expect([foreign.res.code, foreign.res.body.code]).toEqual([403, "tenant_denied"]);
  });
});
