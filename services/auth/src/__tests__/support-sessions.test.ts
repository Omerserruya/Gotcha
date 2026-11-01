/**
 * Support mode's console routes (2026-11-01): start, current, end.
 *   - start: SYSTEM_ADMIN with a console session, a customer tenant, a reason; 2h; one live session per login
 *   - the tenant's support actor is created once and reused; it is a non-login identity
 *   - started/ended are audited in the supported tenant (and start in System)
 *   - end is idempotent and only the starting admin's; logout ends the login's sessions
 *   - the refusal codes are the contract's
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  user: null as any,
  tenants: [] as any[],
  identities: [] as any[],
  users: [] as any[],
  sessions: [] as any[],
  audits: [] as any[],
  seq: 0,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => { req.user = H.user; next(); },
    requireSystemAdmin: () => (req: any, res: any, next: any) => (req.user?.role === "SYSTEM_ADMIN" ? next() : res.status(403).json({ code: "not_system_admin" })),
    withCrossTenantAccess: (fn: any) => fn(),
    writeAudit: async (e: any) => { H.audits.push(e); },
    prisma: {
      tenant: { findUnique: async ({ where }: any) => H.tenants.find((t) => t.id === where.id) ?? null },
      identity: {
        findUnique: async ({ where }: any) => H.identities.find((i) => i.email === where.email) ?? null,
        create: async ({ data }: any) => { const r = { id: `id${++H.seq}`, ...data }; H.identities.push(r); return r; },
      },
      user: {
        findFirst: async ({ where }: any) => H.users.find((u) => u.tenantId === where.tenantId && u.kind === where.kind) ?? null,
        create: async ({ data }: any) => { const r = { id: `u${++H.seq}`, ...data }; H.users.push(r); return r; },
      },
      supportSession: {
        findFirst: async ({ where }: any) => H.sessions.find((s) => s.userSessionId === where.userSessionId && s.endedAt === null && s.expiresAt > where.expiresAt.gt) ?? null,
        findUnique: async ({ where }: any) => H.sessions.find((s) => s.id === where.id) ?? null,
        findMany: async ({ where }: any) => H.sessions.filter((s) => s.userSessionId === where.userSessionId && s.endedAt === null),
        create: async ({ data }: any) => { const r = { id: `ss${++H.seq}`, startedAt: new Date(), endedAt: null, ...data }; H.sessions.push(r); return r; },
        update: async ({ where, data }: any) => Object.assign(H.sessions.find((s) => s.id === where.id), data),
      },
    },
  };
});

import router, { endSupportSessionsForLogin, SUPPORT_SESSION_TTL_MS, SUPPORT_IDENTITY_EMAIL } from "../routes/support-sessions";

const app = express();
app.use(express.json());
app.use("/api/system", router);
const ADMIN = { userId: "u_sys", identityId: "id_omer", tenantId: "t_system", role: "SYSTEM_ADMIN", email: "omer@gotcha.co.il", sessionId: "us_1" };
const start = (body: any) => request(app).post("/api/system/support-sessions").send(body);

beforeEach(() => {
  H.user = { ...ADMIN }; H.identities = []; H.users = []; H.sessions = []; H.audits = []; H.seq = 0;
  H.tenants = [{ id: "t_shop", name: "One Of A Kind", slug: "oneofakind" }, { id: "t_system", name: "System", slug: "system" }];
});

describe("start", () => {
  it("a customer tenant with a reason: 201, two hours, the support actor, audited in the tenant and in System", async () => {
    const before = Date.now();
    const r = await start({ tenantId: "t_shop", reason: "the widget shows defaults" });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ tenantId: "t_shop", tenantName: "One Of A Kind", reason: "the widget shows defaults", actor: { displayName: "GOTCHA Support" } });
    const exp = new Date(r.body.data.expiresAt).getTime();
    expect(exp - before).toBeGreaterThanOrEqual(SUPPORT_SESSION_TTL_MS - 1000);
    expect(exp - before).toBeLessThanOrEqual(SUPPORT_SESSION_TTL_MS + 1000);
    expect(H.sessions[0]).toMatchObject({ tenantId: "t_shop", adminUserId: "u_sys", userSessionId: "us_1", adminIdentityId: "id_omer" });
    expect(H.audits.map((a) => [a.tenantId, a.action])).toEqual([["t_shop", "support.session.started"], ["t_system", "support.session.started"]]);
    expect(H.audits[0]).toMatchObject({ actorType: "support", metadata: { adminUserId: "u_sys", reason: "the widget shows defaults" } });
  });

  it("the support actor: one non-login identity, one hidden ADMIN per tenant, reused", async () => {
    await start({ tenantId: "t_shop", reason: "a" });
    H.sessions[0].endedAt = new Date();
    await start({ tenantId: "t_shop", reason: "b" });
    expect(H.identities).toEqual([expect.objectContaining({ email: SUPPORT_IDENTITY_EMAIL, name: "GOTCHA Support", authentikSubject: null })]);
    expect(H.users).toEqual([expect.objectContaining({ tenantId: "t_shop", kind: "support", role: "ADMIN", name: "GOTCHA Support" })]);
    expect(H.sessions.map((s) => s.supportUserId)).toEqual([H.users[0].id, H.users[0].id]);
  });

  it.each([
    ["a reason missing", { tenantId: "t_shop" }, 400, undefined],
    ["an unknown tenant", { tenantId: "t_none", reason: "x" }, 404, "tenant_not_found"],
    ["the System tenant", { tenantId: "t_system", reason: "x" }, 409, "support_system_tenant"],
  ])("refused for %s", async (_n, body, status, code) => {
    const r = await start(body);
    expect(r.status).toBe(status);
    if (code) expect(r.body.code).toBe(code);
    expect(H.sessions).toHaveLength(0);
  });

  it("one live session per login: 409 support_session_active with its id", async () => {
    const first = await start({ tenantId: "t_shop", reason: "a" });
    const again = await start({ tenantId: "t_shop", reason: "b" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "support_session_active", data: { id: first.body.data.id } });
  });

  it("not a SYSTEM_ADMIN (a support principal is ADMIN): 403", async () => {
    H.user = { ...ADMIN, role: "ADMIN" };
    expect((await start({ tenantId: "t_shop", reason: "x" })).status).toBe(403);
  });

  it("a Bearer principal with no console session: 400 support_requires_session", async () => {
    H.user = { ...ADMIN, sessionId: undefined };
    const r = await start({ tenantId: "t_shop", reason: "x" });
    expect([r.status, r.body.code]).toEqual([400, "support_requires_session"]);
  });
});

describe("current and end", () => {
  it("current shows the live session; end closes it once, audited; current is then empty", async () => {
    const s = (await start({ tenantId: "t_shop", reason: "a" })).body.data;
    expect((await request(app).get("/api/system/support-sessions/current")).body.data).toMatchObject({ id: s.id });
    const e1 = await request(app).post(`/api/system/support-sessions/${s.id}/end`);
    const e2 = await request(app).post(`/api/system/support-sessions/${s.id}/end`);
    expect([e1.status, e2.status]).toEqual([200, 200]);
    expect(H.audits.filter((a) => a.action === "support.session.ended")).toHaveLength(1);
    expect((await request(app).get("/api/system/support-sessions/current")).body.data).toBeNull();
  });

  it("another admin cannot end it: 404", async () => {
    const s = (await start({ tenantId: "t_shop", reason: "a" })).body.data;
    H.user = { ...ADMIN, userId: "u_other" };
    expect((await request(app).post(`/api/system/support-sessions/${s.id}/end`)).status).toBe(404);
    expect(H.sessions[0].endedAt).toBeNull();
  });

  it("logout ends the login's support sessions with reason logout", async () => {
    await start({ tenantId: "t_shop", reason: "a" });
    expect(await endSupportSessionsForLogin("us_1", "logout")).toBe(1);
    expect(H.sessions[0]).toMatchObject({ endedReason: "logout" });
    expect(H.sessions[0].endedAt).toBeInstanceOf(Date);
  });
});
