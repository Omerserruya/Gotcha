/**
 * Support mode across services (2026-11-01): every change made in support mode
 * is logged under the admin, including writes another service makes for it.
 *
 * Simulated ai -> conversation: a route running in support mode calls another
 * service with the internal key; that service's audit row is "support" with the
 * session and the admin. The header is attribution only - it never widens
 * access, it is ignored without the internal key, and it must name a real
 * session (of the named tenant).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => { process.env.INTERNAL_SERVICE_KEY = "k".repeat(40); });

const DB = vi.hoisted(() => ({ sessions: new Map<string, any>(), audits: [] as any[] }));

vi.mock("../lib/prisma", () => ({
  prisma: {
    supportSession: { findUnique: async ({ where }: any) => DB.sessions.get(where.id) ?? null },
    tenant: { findUnique: async ({ where }: any) => (["t_shop", "t_other"].includes(where.id) ? { id: where.id } : null) },
    auditLog: { create: async ({ data }: any) => { DB.audits.push(data); return data; } },
  },
  withCrossTenantAccess: (fn: any) => fn(),
}));
vi.mock("../lib/session-principal", () => ({ readSessionCookie: () => null, resolvePrincipalFromSessionToken: async () => { throw new Error("no cookie here"); } }));
vi.mock("../lib/session-flags", () => ({ readSessionFlags: () => ({ cookieAccept: true, cookieOnlyEnforce: false, legacyBearerAccept: false }) }));

import { installSupportAuditPropagation, __resetSupportAuditPropagation, SUPPORT_AUDIT_HEADER } from "../lib/support-audit";
import { runWithRequestContext } from "../lib/request-context";
import { authenticate } from "../middleware/auth";
import { requireInternalKey } from "../lib/internal-key";
import { writeAudit } from "../lib/audit";

const KEY = "k".repeat(40);
const sent: Array<Headers> = [];

beforeEach(() => {
  DB.sessions.clear(); DB.audits = []; sent.length = 0;
  DB.sessions.set("ss_1", { id: "ss_1", tenantId: "t_shop", adminUserId: "u_sys" });
  __resetSupportAuditPropagation();
  globalThis.fetch = (async (_input: any, init?: any) => { sent.push(new Headers(init?.headers)); return new Response("{}"); }) as any;
  installSupportAuditPropagation();
});

/** The receiving service: authenticate() on an internal call, then a route that audits. */
async function receive(headers: Record<string, string>) {
  const req: any = { headers, method: "PATCH", originalUrl: "/api/conversations/c1", url: "/api/conversations/c1", body: {} };
  const res: any = { code: 0, status(c: number) { this.code = c; return this; }, json() { return this; } };
  let user: any = null;
  await new Promise<void>((done) => {
    void authenticate(req, res, async () => {
      user = req.user;
      await writeAudit({ tenantId: "t_shop", actorType: "system", actorId: null, action: "conversation.updated" });
      done();
    }).then(() => { if (res.code) done(); });
  });
  return { user, res };
}

describe("ai -> conversation in support mode", () => {
  it("the internal call carries the session, and the receiving write is logged under the admin", async () => {
    // ai, inside a support-mode request:
    await runWithRequestContext({ supportSessionId: "ss_1", supportAdminUserId: "u_sys" }, () =>
      fetch("http://conversation:4002/api/conversations/c1", { method: "PATCH", headers: { Authorization: `Bearer ${KEY}`, "x-tenant-id": "t_shop" } }),
    );
    expect(sent[0].get(SUPPORT_AUDIT_HEADER)).toBe("ss_1");

    // conversation, receiving exactly those headers:
    const { user } = await receive(Object.fromEntries(sent[0].entries()));
    expect(DB.audits.at(-1)).toMatchObject({ actorType: "support", metadata: { support: { supportSessionId: "ss_1", adminUserId: "u_sys" } } });
    // Attribution only: still the plain internal principal.
    expect(user).toMatchObject({ userId: "system", role: "ADMIN", isInternal: true, tenantId: "t_shop" });
  });

  it("a fetch without the internal key gets no header (nothing leaks to the outside)", async () => {
    await runWithRequestContext({ supportSessionId: "ss_1" }, () => fetch("https://api.example.com/x", { headers: { Authorization: "Bearer someone-else" } }));
    expect(sent[0].has(SUPPORT_AUDIT_HEADER)).toBe(false);
  });

  it("outside support mode internal calls are unchanged", async () => {
    await fetch("http://conversation:4002/x", { headers: { Authorization: `Bearer ${KEY}` } });
    expect(sent[0].has(SUPPORT_AUDIT_HEADER)).toBe(false);
  });

  it("the header names another tenant's session: ignored, the write stays system", async () => {
    await receive({ authorization: `Bearer ${KEY}`, "x-tenant-id": "t_other", [SUPPORT_AUDIT_HEADER]: "ss_1" });
    expect(DB.audits.at(-1)).toMatchObject({ actorType: "system" });
    expect(DB.audits.at(-1).metadata).toBeUndefined();
  });

  it("an unknown session: ignored", async () => {
    await receive({ authorization: `Bearer ${KEY}`, "x-tenant-id": "t_shop", [SUPPORT_AUDIT_HEADER]: "ss_nope" });
    expect(DB.audits.at(-1)).toMatchObject({ actorType: "system" });
  });

  it("without the internal key the header is never read (a browser cannot claim to be support)", async () => {
    const { res } = await receive({ authorization: "Bearer not-the-key", "x-tenant-id": "t_shop", [SUPPORT_AUDIT_HEADER]: "ss_1" });
    expect(res.code).toBe(401);
    expect(DB.audits).toHaveLength(0);
  });

  it("an X-Internal-Key route (requireInternalKey) attributes the same way", async () => {
    const req: any = { headers: { "x-internal-key": KEY, "x-tenant-id": "t_shop", [SUPPORT_AUDIT_HEADER]: "ss_1" } };
    const res: any = { status() { return this; }, json() { return this; } };
    await new Promise<void>((done) => requireInternalKey(req, res, async () => {
      await writeAudit({ tenantId: "t_shop", actorType: "system", action: "x" });
      done();
    }));
    expect(DB.audits.at(-1)).toMatchObject({ actorType: "support", metadata: { support: { supportSessionId: "ss_1" } } });
  });

  it("an AI employee's own action stays ai, with the support stamp", async () => {
    await runWithRequestContext({ supportSessionId: "ss_1", supportAdminUserId: "u_sys" }, () =>
      writeAudit({ tenantId: "t_shop", actorType: "ai", action: "ai.reply" }),
    );
    expect(DB.audits.at(-1)).toMatchObject({ actorType: "ai", metadata: { support: { supportSessionId: "ss_1" } } });
  });
});
