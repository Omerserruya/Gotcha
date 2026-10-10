/**
 * ★ Disconnecting Shopify stops the storefront chat, locally only (2026-10-10).
 * The chat was served from its own channel and installation, which a
 * disconnect never touched, so the storefront chat stayed live.
 *   - each disconnected store's chat installation is retired
 *     (markUninstalledByShop: channel disabled and DISCONNECTED, installation
 *     UNINSTALLED, token dropped) and its workspace binding released
 *   - the answer is { ok, chatDisabled, billing: "unchanged" }; nothing
 *     reaches billing or Shopify
 *   - idempotent: a second disconnect answers chatDisabled false
 *   - another system's disconnect touches no chat
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.gotcha.co.il";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "a".repeat(64);
});
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); async set() { return "OK"; } } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const DB = vi.hoisted(() => ({ integrations: [] as any[], installs: [] as any[], marked: [] as string[], billing: 0, fetches: 0 }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    withCrossTenantAccess: async (fn: any) => fn(),
    prisma: {
      tenantIntegration: {
        findMany: async (a: any) => DB.integrations.filter((r) => r.tenantId === a.where.tenantId && r.integrationId === a.where.integrationId),
        update: async (a: any) => { const r = DB.integrations.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
      },
      calendarAccount: { updateMany: async () => ({ count: 0 }) },
      shopifyChatInstallation: {
        update: async (a: any) => { const r = DB.installs.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
      },
    },
    authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "user-1", role: "ADMIN" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "tenant-A"; next(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/connector-connection.service", () => ({
  findCatalog: vi.fn(async (slug: string) => ({ id: `cat_${slug}`, slug })),
  upsertConnection: vi.fn(),
}));
vi.mock("../services/shopify-chat-install.service", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  markUninstalledByShop: vi.fn(async (shop: string) => {
    DB.marked.push(shop);
    const inst = DB.installs.find((i) => i.shopDomain === shop && i.status !== "UNINSTALLED");
    if (!inst) return null;
    inst.status = "UNINSTALLED";
    return { ...inst };
  }),
}));
vi.mock("../services/shopify-billing-bridge.service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const spy = (fn: any) => (...a: any[]) => { DB.billing++; return fn(...a); };
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === "function" ? spy(v) : v]));
});

import router from "../routes/connectors-admin";

const app = express();
app.use(express.json());
app.use("/api", router);
const disconnect = (slug: string) => request(app).post(`/api/connectors/${slug}/disconnect`).send({});

beforeEach(() => {
  DB.integrations = [
    { id: "ti_s", tenantId: "tenant-A", integrationId: "cat_shopify", status: "CONNECTED", config: { shopDomain: "Demo-Store.myshopify.com", useAsCrm: true } },
    { id: "ti_h", tenantId: "tenant-A", integrationId: "cat_hubspot", status: "CONNECTED", config: {} },
  ];
  DB.installs = [{ id: "inst1", shopDomain: "demo-store.myshopify.com", status: "ACTIVE", tenantId: "tenant-A", channelAccountId: "ca_chat" }];
  DB.marked = []; DB.billing = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { DB.fetches++; return { ok: true, json: async () => ({}) }; }));
  DB.fetches = 0;
});

describe("★ a Shopify disconnect stops the storefront chat, locally", () => {
  it("the chat installation is retired and released; the answer says billing is unchanged", async () => {
    const r = await disconnect("shopify");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, chatDisabled: true, billing: "unchanged" });
    expect(DB.marked).toEqual(["demo-store.myshopify.com"]);
    expect(DB.installs[0]).toMatchObject({ status: "UNINSTALLED", tenantId: null, channelAccountId: null });
    expect(DB.integrations[0]).toMatchObject({ status: "DISCONNECTED", credentials: {}, config: { useAsCrm: true } });
  });

  it("nothing reaches billing or Shopify", async () => {
    await disconnect("shopify");
    expect(DB.billing).toBe(0);
    expect(DB.fetches).toBe(0);
  });

  it("idempotent: a second disconnect answers chatDisabled false", async () => {
    await disconnect("shopify");
    const again = await disconnect("shopify");
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, chatDisabled: false, billing: "unchanged" });
  });

  it("another system's disconnect touches no chat", async () => {
    const r = await disconnect("hubspot");
    expect(r.body).toEqual({ ok: true, chatDisabled: false, billing: "unchanged" });
    expect(DB.marked).toEqual([]);
    expect(DB.installs[0].status).toBe("ACTIVE");
  });
});
