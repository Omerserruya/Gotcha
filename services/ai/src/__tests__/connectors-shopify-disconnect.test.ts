/**
 * Disconnecting Shopify (split billing 2026-10-28) is uninstalling the app on
 * Shopify: the route asks Shopify (appUninstall) and answers awaiting_webhook.
 * Nothing local changes until Shopify's signed app/uninstalled arrives, which
 * disconnects the connection, revokes the Shopify-funded access, removes the
 * tool assignments and stops the storefront chat (shopify-webhooks). The old
 * local-only disconnect left the app installed and Shopify billing running.
 *   - another system's disconnect is unchanged and touches no chat
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

const DB = vi.hoisted(() => ({ integrations: [] as any[], installs: [] as any[], marked: [] as string[], billing: 0, fetches: 0, uninstallAsked: [] as string[], uninstall: { status: 200, body: { data: { state: "awaiting_webhook", shopDomain: "demo-store.myshopify.com" } } } as any }));
vi.mock("../services/connectors/shopify-self-uninstall.service", () => ({
  shopifyUninstallResponse: vi.fn(async (tenantId: string) => { DB.uninstallAsked.push(tenantId); return DB.uninstall; }),
}));
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
  DB.marked = []; DB.billing = 0; DB.uninstallAsked = [];
  DB.uninstall = { status: 200, body: { data: { state: "awaiting_webhook", shopDomain: "demo-store.myshopify.com" } } };
  vi.stubGlobal("fetch", vi.fn(async () => { DB.fetches++; return { ok: true, json: async () => ({}) }; }));
  DB.fetches = 0;
});

describe("★ a Shopify disconnect is an uninstall on Shopify", () => {
  it("asks Shopify and answers awaiting_webhook; nothing local changes yet", async () => {
    const r = await disconnect("shopify");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { state: "awaiting_webhook", shopDomain: "demo-store.myshopify.com" } });
    expect(DB.uninstallAsked).toEqual(["tenant-A"]);
    expect(DB.integrations[0]).toMatchObject({ status: "CONNECTED", config: { shopDomain: "Demo-Store.myshopify.com" } });
    expect(DB.installs[0].status).toBe("ACTIVE");
    expect(DB.marked).toEqual([]);
  });

  it("Shopify's refusal and our preconditions keep their codes", async () => {
    for (const [status, error] of [[404, "not_connected"], [409, "no_token"], [409, "no_shop_domain"], [502, "shopify_refused"]] as const) {
      DB.uninstall = { status, body: { error } };
      const r = await disconnect("shopify");
      expect([r.status, r.body]).toEqual([status, { error }]);
    }
  });
});

describe("other systems", () => {
  it("another system's disconnect touches no chat", async () => {
    const r = await disconnect("hubspot");
    expect(r.body).toEqual({ ok: true, chatDisabled: false, billing: "unchanged" });
    expect(DB.marked).toEqual([]);
    expect(DB.installs[0].status).toBe("ACTIVE");
  });
});
