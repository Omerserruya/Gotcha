/**
 * Support mode (2026-11-01): a GOTCHA admin working inside a tenant.
 *   - the deny table: exactly what Omer refused, with the contract's codes; automations and knowledge stay open
 *   - the principal: only a live session of THIS login, for THIS tenant; ADMIN, never SYSTEM_ADMIN
 *   - authenticate(): support header honoured only with a valid session; refusals 401/403 with stable codes
 *   - lists and counts of users skip the hidden support actor
 *   - every audit row written in support mode says so
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  users: new Map<string, any>(),
  base: null as any,
  audits: [] as any[],
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    supportSession: { findUnique: async ({ where }: any) => DB.sessions.get(where.id) ?? null },
    user: { findFirst: async ({ where }: any) => [...DB.users.values()].find((u) => u.id === where.id && u.tenantId === where.tenantId && u.kind === where.kind) ?? null },
    auditLog: { create: async ({ data }: any) => { DB.audits.push(data); return data; } },
  },
  withCrossTenantAccess: (fn: any) => fn(),
}));
vi.mock("../lib/session-principal", () => ({
  readSessionCookie: () => "sess-token",
  resolvePrincipalFromSessionToken: async (_raw: string, hint: string | null) => {
    if (hint && hint !== DB.base.tenantId) {
      const { AuthError } = await import("../lib/principal");
      throw new AuthError("No membership in the requested tenant", "tenant_denied");
    }
    return DB.base;
  },
}));
vi.mock("../lib/session-flags", () => ({ readSessionFlags: () => ({ cookieAccept: true, cookieOnlyEnforce: true, legacyBearerAccept: false }) }));

import { supportDenial } from "../lib/support-deny";
import { resolveSupportPrincipal } from "../lib/support-principal";
import { authenticate } from "../middleware/auth";
import { applyMembersByDefault } from "../lib/members-by-default";
import { writeAudit } from "../lib/audit";

const ADMIN = { userId: "u_sys", identityId: "id_admin", tenantId: "t_system", role: "SYSTEM_ADMIN", email: "omer@gotcha.co.il", sessionId: "us_1" };
const HOUR = 3_600_000;

beforeEach(() => {
  DB.sessions.clear(); DB.users.clear(); DB.audits = []; DB.base = { ...ADMIN };
  DB.users.set("u_support", { id: "u_support", tenantId: "t_shop", kind: "support", email: "support@gotcha.internal" });
  DB.sessions.set("ss_1", { id: "ss_1", tenantId: "t_shop", adminUserId: "u_sys", userSessionId: "us_1", supportUserId: "u_support", reason: "fix the widget", startedAt: new Date(), expiresAt: new Date(Date.now() + 2 * HOUR), endedAt: null });
});

describe("what support mode may not do", () => {
  it.each([
    ["POST", "/api/billing/subscription/change-plan", "support_denied:billing"],
    ["PUT", "/api/billing/auto-purchase", "support_denied:billing"],
    ["POST", "/api/checkout/ref_1/payment-session", "support_denied:billing"],
    ["POST", "/api/auto-buy/rules", "support_denied:billing"],
    ["DELETE", "/api/conversations/c1", "support_denied:delete"],
    ["DELETE", "/api/conversations/c1/messages/m1", "support_denied:delete"],
    ["DELETE", "/api/ai-agents/a1", "support_denied:delete"],
    ["POST", "/api/channels/ch1/disconnect", "support_denied:delete"],
    ["DELETE", "/api/channels/ch1", "support_denied:delete"],
    ["DELETE", "/api/channels/whatsapp/numbers/n1", "support_denied:delete"],
    ["POST", "/api/integrations/shopify/uninstall", "support_denied:delete"],
    ["POST", "/api/integrations/hubspot/disconnect", "support_denied:delete"],
    ["POST", "/api/connectors/woocommerce/disconnect", "support_denied:delete"],
    ["DELETE", "/api/woocommerce-plugin/sites/s1", "support_denied:delete"],
    ["DELETE", "/api/gdpr/users/u1", "support_denied:delete"],
    ["DELETE", "/api/agents/u2", "support_denied:ownership"],
    ["POST", "/api/voice-channels/v1/rotate-secrets", "support_denied:secrets"],
  ])("%s %s -> %s", (m, path, code) => {
    expect(supportDenial(m, path, {})).toBe(code);
  });

  it("a role change or deactivation is ownership; a name change is not", () => {
    expect(supportDenial("PATCH", "/api/agents/u2", { role: "ADMIN" })).toBe("support_denied:ownership");
    expect(supportDenial("PATCH", "/api/agents/u2", { isActive: false })).toBe("support_denied:ownership");
    expect(supportDenial("PATCH", "/api/agents/u2", { name: "Dana" })).toBeNull();
  });

  it("inviting an admin is ownership; inviting an agent is not", () => {
    expect(supportDenial("POST", "/api/agents", { role: "ADMIN" })).toBe("support_denied:ownership");
    expect(supportDenial("POST", "/api/agents", { role: "AGENT" })).toBeNull();
  });

  it.each([
    ["GET", "/api/billing/subscription"],
    ["GET", "/api/conversations/c1"],
    ["POST", "/api/conversations/c1/messages"],
    ["DELETE", "/api/conversations/c1/archive"],
    ["PATCH", "/api/chatbot/flows/f1"],
    ["DELETE", "/api/chatbot/flows/f1"],
    ["DELETE", "/api/knowledge-bases/k1"],
    ["PATCH", "/api/knowledge-bases/k1"],
    ["POST", "/api/integrations/shopify/install/start"],
    ["PUT", "/api/website-widget"],
    ["DELETE", "/api/channels/whatsapp/exclusions/e1"],
  ])("%s %s stays allowed (automations, knowledge, reconnect, everyday work)", (m, path) => {
    expect(supportDenial(m, path, {})).toBeNull();
  });

  it("query strings and trailing slashes do not slip past", () => {
    expect(supportDenial("DELETE", "/api/conversations/c1?x=1", {})).toBe("support_denied:delete");
    expect(supportDenial("DELETE", "/api/ai-agents/a1/", {})).toBe("support_denied:delete");
  });
});

describe("the support principal", () => {
  it("a live session of this login, for this tenant: the tenant's ADMIN, acting as the support actor", async () => {
    const p: any = await resolveSupportPrincipal(ADMIN, "ss_1", "t_shop");
    expect(p).toMatchObject({ userId: "u_support", tenantId: "t_shop", role: "ADMIN", identityId: "id_admin" });
    expect(p.role).not.toBe("SYSTEM_ADMIN");
    expect(p.support).toMatchObject({ sessionId: "ss_1", adminUserId: "u_sys", adminEmail: "omer@gotcha.co.il", reason: "fix the widget" });
  });

  it.each([
    ["another login's session", () => { DB.sessions.get("ss_1").userSessionId = "us_other"; }, "support_session_invalid"],
    ["another tenant", () => {}, "support_session_invalid", "t_other"],
    ["no tenant named", () => {}, "support_session_invalid", null],
    ["an ended session", () => { DB.sessions.get("ss_1").endedAt = new Date(); }, "support_expired"],
    ["an expired session", () => { DB.sessions.get("ss_1").expiresAt = new Date(Date.now() - 1); }, "support_expired"],
    ["an unknown session", () => { DB.sessions.clear(); }, "support_session_invalid"],
    ["a missing support actor", () => { DB.users.clear(); }, "support_session_invalid"],
  ] as const)("refused for %s", async (_n, setup, code, tenant = "t_shop") => {
    setup();
    await expect(resolveSupportPrincipal(ADMIN, "ss_1", tenant as any)).rejects.toMatchObject({ code });
  });

  it("refused for anyone who is not a SYSTEM_ADMIN", async () => {
    await expect(resolveSupportPrincipal({ ...ADMIN, role: "ADMIN" }, "ss_1", "t_shop")).rejects.toMatchObject({ code: "support_session_invalid" });
  });
});

describe("authenticate() in support mode", () => {
  const run = async (headers: Record<string, string>, method = "GET", url = "/api/conversations", body: any = {}) => {
    const req: any = { headers: { cookie: "s=1", ...headers }, method, originalUrl: url, url, body };
    const res: any = { code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    let nexted = false;
    await authenticate(req, res, () => { nexted = true; });
    return { req, res, nexted };
  };

  it("with a valid session: the target tenant, as its ADMIN", async () => {
    const { req, nexted } = await run({ "x-support-session": "ss_1", "x-tenant-id": "t_shop" });
    expect(nexted).toBe(true);
    expect(req.tenantId).toBe("t_shop");
    expect(req.user).toMatchObject({ role: "ADMIN", userId: "u_support" });
  });

  it("the bare header without a support session is still membership-only: tenant_denied", async () => {
    const { res, nexted } = await run({ "x-tenant-id": "t_shop" });
    expect(nexted).toBe(false);
    expect([res.code, res.body.code]).toEqual([403, "tenant_denied"]);
  });

  it("an expired session: 401 support_expired, never the admin's own tenant", async () => {
    DB.sessions.get("ss_1").expiresAt = new Date(Date.now() - 1);
    const { res, nexted } = await run({ "x-support-session": "ss_1", "x-tenant-id": "t_shop" });
    expect(nexted).toBe(false);
    expect([res.code, res.body.code]).toEqual([401, "support_expired"]);
  });

  it("a denied action: 403 with the contract's code, before any route runs", async () => {
    const { res, nexted } = await run({ "x-support-session": "ss_1", "x-tenant-id": "t_shop" }, "DELETE", "/api/conversations/c1");
    expect(nexted).toBe(false);
    expect([res.code, res.body.code]).toEqual([403, "support_denied:delete"]);
  });

  it("an audit row written during a support request is marked support, with the admin", async () => {
    await run({ "x-support-session": "ss_1", "x-tenant-id": "t_shop" }, "PATCH", "/api/chatbot/flows/f1");
    // Inside a request the route would call writeAudit; simulate it inside the same context.
    const { runWithRequestContext } = await import("../lib/request-context");
    await runWithRequestContext({ supportSessionId: "ss_1", supportAdminUserId: "u_sys" }, () =>
      writeAudit({ tenantId: "t_shop", actorType: "user", actorId: "u_support", action: "automation.updated" }),
    );
    expect(DB.audits.at(-1)).toMatchObject({ actorType: "support", actorId: "u_support", metadata: { support: { supportSessionId: "ss_1", adminUserId: "u_sys" } } });
  });

  it("outside support mode audit rows are unchanged", async () => {
    await writeAudit({ tenantId: "t_shop", actorType: "user", actorId: "u1", action: "x", metadata: { a: 1 } });
    expect(DB.audits.at(-1)).toMatchObject({ actorType: "user", metadata: { a: 1 } });
    expect(DB.audits.at(-1).metadata).not.toHaveProperty("support");
  });
});

describe("the support actor is not a team member", () => {
  it("user lists and counts get kind = member", () => {
    expect(applyMembersByDefault("User", "findMany", { where: { tenantId: "t" } })).toEqual({ where: { tenantId: "t", kind: "member" } });
    expect(applyMembersByDefault("User", "count", { where: { tenantId: "t", isActive: true } })).toEqual({ where: { tenantId: "t", isActive: true, kind: "member" } });
    expect(applyMembersByDefault("User", "count", undefined)).toEqual({ where: { kind: "member" } });
  });
  it("a caller that names kind, a lookup by id, and other models are untouched", () => {
    expect(applyMembersByDefault("User", "findMany", { where: { kind: "support" } })).toEqual({ where: { kind: "support" } });
    expect(applyMembersByDefault("User", "findUnique", { where: { id: "u" } })).toEqual({ where: { id: "u" } });
    expect(applyMembersByDefault("User", "findFirst", { where: { tenantId: "t" } })).toEqual({ where: { tenantId: "t" } });
    expect(applyMembersByDefault("Conversation", "findMany", { where: {} })).toEqual({ where: {} });
  });
});
