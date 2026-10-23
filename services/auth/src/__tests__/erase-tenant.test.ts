/**
 * eraseTenant: what a permanent tenant delete does, in order (2026-10-23).
 *
 * Mocks only - a recording prisma, stubbed Authentik and a stubbed fetch for
 * the Qdrant and uploads calls. The real run is the throwaway-tenant check on
 * dev, recorded in the PR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { ERASED_EXPLICITLY } from "../services/tenant-erasure-tables";

const H = vi.hoisted(() => ({
  ops: [] as string[],
  audit: null as any,
  sub: null as any,
  funded: 1,
  erasedSubjects: [] as string[],
  otherMemberships: 0,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const rec = (name: string) => new Proxy({}, {
    get: (_t, op: string) => async (args: any) => {
      H.ops.push(`${name}.${op}`);
      if (name === "auditLog" && op === "create") H.audit = args.data;
      return undefined;
    },
  });
  const db: any = new Proxy({
    tenant: {
      findUnique: async ({ select }: any) => (select?._count
        ? { _count: { users: 1, conversations: 3, messages: 9, channelAccounts: 1, contacts: 2 } }
        : { id: "T", name: "Acme", slug: "acme" }),
      delete: async () => { H.ops.push("tenant.delete"); },
    },
    user: {
      findMany: async () => [{ id: "u1", identityId: "i1", identity: { authentikSubject: "sub1" } }],
      count: async () => H.otherMemberships,
    },
    message: { findMany: async () => [{ mediaUrl: "/api/uploads/0f8fad5b-d9cb-469f-a165-70867728950e.jpg" }, { mediaUrl: "https://elsewhere/x.png" }] },
    scheduledMessage: { findMany: async () => [{ mediaUrl: "/api/uploads/7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf?x=1" }] },
    channelAccount: { findMany: async () => [{ channel: "WHATSAPP", displayName: "Acme WA", externalId: "pn1" }] },
    tenantIntegration: { findMany: async () => [{ status: "CONNECTED", integration: { slug: "hubspot" } }] },
    commerceConnection: { findMany: async () => [] },
    calendarAccount: { findMany: async () => [] },
    knowledgeIntegration: { findMany: async () => [] },
    shopifyChatInstallation: { findMany: async () => [] },
    billableEntityTenant: {
      findMany: async () => [{ billableEntityId: "E" }],
      count: async () => H.funded,
    },
    subscription: {
      findUnique: async () => H.sub,
      update: async ({ data }: any) => { H.ops.push("subscription.update"); Object.assign(H.sub, data); },
    },
    pendingSubscriptionChange: { deleteMany: async () => { H.ops.push("pendingSubscriptionChange.deleteMany"); } },
    subscriptionEvent: { create: async () => { H.ops.push("subscriptionEvent.create"); } },
    identity: { deleteMany: async () => { H.ops.push("identity.deleteMany"); } },
  }, {
    // A defined model keeps its own methods and records every other one.
    get: (t: any, k: string) => (k in t
      ? new Proxy(t[k], { get: (m: any, op: string) => (op in m ? m[op] : (rec(k) as any)[op]) })
      : rec(k)),
  });
  db.$transaction = async (fn: any) => fn(db);
  return { ...actual, prisma: db, getInternalServiceKey: () => "k", writeAudit: async () => {} };
});
vi.mock("../services/invitation.service", () => ({
  eraseUserIdentity: async (s: string) => { H.erasedSubjects.push(s); return true; },
}));

import { eraseTenant } from "../services/gdpr.service";

let calls: any[] = [];
let uploadsReply: { status: number; body: any } = { status: 200, body: { ok: true, removed: 2, missing: 0 } };
let logged: string[] = [];

beforeEach(() => {
  H.ops = []; H.audit = null; H.erasedSubjects = []; H.otherMemberships = 0; H.funded = 1;
  H.sub = { id: "s1", status: "ACTIVE", cancelAtPeriodEnd: true };
  calls = []; logged = [];
  uploadsReply = { status: 200, body: { ok: true, removed: 2, missing: 0 } };
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = url.includes("/internal/uploads/purge") ? uploadsReply : { status: 200, body: {} };
    return { status: r.status, ok: r.status < 300, json: async () => r.body } as any;
  });
  vi.spyOn(console, "log").mockImplementation((m: any) => { logged.push(String(m)); });
  vi.spyOn(console, "error").mockImplementation((m: any) => { logged.push(String(m)); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("eraseTenant", () => {
  it("erases every listed table, then the tenant, then writes the one audit row that survives", async () => {
    await eraseTenant("T", "sa1", { reason: "closing" });
    const deletes = H.ops.filter((o) => o.endsWith(".deleteMany") && o !== "pendingSubscriptionChange.deleteMany" && o !== "identity.deleteMany");
    expect(deletes).toEqual(ERASED_EXPLICITLY.map((m) => `${m}.deleteMany`));
    const at = (o: string) => H.ops.indexOf(o);
    expect(at("auditLog.deleteMany")).toBeLessThan(at("tenant.delete"));
    expect(at("tenant.delete")).toBeLessThan(at("identity.deleteMany"));
    expect(H.ops[H.ops.length - 1]).toBe("auditLog.create");
    expect(H.audit).toMatchObject({
      tenantId: "T", actorId: "sa1", action: "tenant.deleted",
      metadata: { deletedTenantId: "T", slug: "acme", name: "Acme", reason: "closing", counts: { messages: 9 } },
    });
    expect(logged.some((l) => l.startsWith("[gdpr] tenant deleted ") && l.includes('"reason":"closing"'))).toBe(true);
  });

  it("removes only stored uploads, by name, after the commit", async () => {
    const out: any = await eraseTenant("T", "sa1");
    const purge = calls.find((c) => c.url.endsWith("/internal/uploads/purge"));
    expect(purge.body.files.sort()).toEqual(["0f8fad5b-d9cb-469f-a165-70867728950e.jpg", "7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf"]);
    expect(out).toMatchObject({ uploadsRemoved: true, uploadFiles: 2, uploadsLeftBehind: [] });
  });

  it("a failed or partial unlink never undoes the delete: it is reported and logged", async () => {
    uploadsReply = { status: 207, body: { ok: false, removed: 1, failed: ["x"] } };
    const out: any = await eraseTenant("T", "sa1");
    expect(H.ops).toContain("tenant.delete");
    expect(out.uploadsRemoved).toBe(false);
    expect(out.uploadsLeftBehind).toHaveLength(2);
    expect(logged.some((l) => l.includes("uploads NOT removed for deleted tenant T"))).toBe(true);
  });

  it("reports what is left on the provider side, and calls no provider", async () => {
    const out: any = await eraseTenant("T", "sa1");
    expect(out.providerLeftovers).toEqual([
      expect.stringMatching(/^WHATSAPP:Acme WA \(pn1\): number stays registered/),
      expect.stringMatching(/^integration:hubspot: the OAuth grant stays authorized/),
    ]);
    for (const c of calls) expect(c.url).toMatch(/\/api\/gdpr-internal\/purge-tenant-vectors$|\/internal\/uploads\/purge$/);
  });

  it("closes a subscription its entity funds only this tenant with, so nothing can charge it later", async () => {
    H.sub = { id: "s1", status: "ACTIVE", cancelAtPeriodEnd: true, trialEndsAt: null };
    await eraseTenant("T", "sa1");
    expect(H.sub).toMatchObject({ status: "CANCELED", cancelAtPeriodEnd: true, trialEndsAt: null });
    expect(H.ops).toContain("pendingSubscriptionChange.deleteMany");
  });

  it("leaves a shared entity's subscription alone", async () => {
    H.funded = 2;
    await eraseTenant("T", "sa1");
    expect(H.sub.status).toBe("ACTIVE");
    expect(H.ops).not.toContain("subscription.update");
  });

  it("erases the Authentik login only for a person with no other membership", async () => {
    await eraseTenant("T", "sa1");
    expect(H.erasedSubjects).toEqual(["sub1"]);
    H.erasedSubjects = []; H.otherMemberships = 1;
    await eraseTenant("T", "sa1");
    expect(H.erasedSubjects).toEqual([]);
  });
});

describe("the /api/gdpr door gains the same refusals, and nothing else", () => {
  it("refuses with 409 and the code; erases nothing", async () => {
    vi.resetModules();
    vi.doMock("../services/gdpr.service", async (orig) => ({
      ...(await orig<any>()),
      tenantDeletionRefusal: async () => ({ code: "OPEN_CHECKOUT" }),
      eraseTenant: async () => { throw new Error("must not erase"); },
    }));
    vi.doMock("@chatcenter/shared", async (orig) => ({
      ...(await orig<any>()),
      authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "sa1" }; n(); },
      requireSystemAdmin: () => (_q: any, _s: any, n: any) => n(),
    }));
    const { default: gdpr } = await import("../routes/gdpr");
    const app = express();
    app.use(express.json());
    app.use("/api/gdpr", gdpr);
    const r = await request(app).delete("/api/gdpr/tenants/T");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "erasure_refused", code: "OPEN_CHECKOUT" });
  });

  it("with no refusal it erases exactly as before: same call, same response shape", async () => {
    vi.resetModules();
    const seen: any[] = [];
    vi.doMock("../services/gdpr.service", async (orig) => ({
      ...(await orig<any>()),
      tenantDeletionRefusal: async () => null,
      eraseTenant: async (...a: any[]) => { seen.push(a); return { deleted: true, tenantId: "T" }; },
    }));
    vi.doMock("@chatcenter/shared", async (orig) => ({
      ...(await orig<any>()),
      authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "sa1" }; n(); },
      requireSystemAdmin: () => (_q: any, _s: any, n: any) => n(),
    }));
    const { default: gdpr } = await import("../routes/gdpr");
    const app = express();
    app.use(express.json());
    app.use("/api/gdpr", gdpr);
    const r = await request(app).delete("/api/gdpr/tenants/T");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { deleted: true, tenantId: "T" } });
    expect(seen).toEqual([["T", "sa1"]]);
  });
});
