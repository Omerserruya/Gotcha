/**
 * Split billing (2026-10-28): the integrations screen takes Shopify's status
 * and its usable actions from the Connector's one verdict (billing's
 * GET /api/billing/shopify/state), never from the OAuth row being CONNECTED.
 * "Connected / N actions" over an unpaid Connector is what Shopify's review
 * (132211) read as access outside Shopify billing.
 *   - the shopify entry carries shopifyConnector { scope, billedBy, grantsAccess, status, capabilities }
 *   - each Shopify tool carries requiredCapability and usable (its own entitlement)
 *   - other systems are untouched; no verdict is fetched when Shopify is not connected
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const H = vi.hoisted(() => ({
  connected: true,
  calls: 0,
  summary: null as any,
}));
const tool = (slug: string) => ({ id: `t_${slug}`, slug, name: slug, description: slug, tenantTools: [] });
const rows = () => [
  {
    id: "cat_shopify", slug: "shopify", name: "Shopify", description: "Store", longDescription: null, authType: "OAUTH2", authSchema: null,
    catalogTools: [tool("search_products"), tool("get_order"), tool("cancel_order"), tool("brand_new_tool")],
    tenantConnections: H.connected ? [{ id: "ti1", status: "CONNECTED", createdAt: new Date(), config: { shopDomain: "acme.myshopify.com" } }] : [],
  },
  {
    id: "cat_hubspot", slug: "hubspot", name: "HubSpot", description: "CRM", longDescription: null, authType: "OAUTH2", authSchema: null,
    catalogTools: [tool("create_contact")],
    tenantConnections: [{ id: "ti2", status: "CONNECTED", createdAt: new Date(), config: {} }],
  },
];

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: { integrationCatalog: { findMany: async () => rows() } },
    resolveEffectiveLocale: async () => ({ effective: "en" }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/shopify-billing-bridge.service", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getShopifyConnectorSummary: vi.fn(async () => { H.calls++; return H.summary; }),
}));

import router from "../routes/integrations";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);
const list = async () => (await request(app).get("/api/integrations")).body.data as any[];
const caps = (o: Record<string, boolean>) => ({ shopify_catalog_sync: false, shopify_order_read: false, shopify_order_actions: false, shopify_storefront_widget: false, ...o });

beforeEach(() => {
  H.connected = true;
  H.calls = 0;
  H.summary = { scope: "shopify_connector", billedBy: "shopify", grantsAccess: false, status: "authorized_not_active", capabilities: caps({}) };
});

describe("Shopify's status and usable actions come from the Connector's verdict", () => {
  it("OAuth CONNECTED without the Connector: authorized_not_active, zero usable actions", async () => {
    const shopify = (await list()).find((e) => e.slug === "shopify");
    expect(shopify.tenantConnection.status).toBe("CONNECTED");
    expect(shopify.shopifyConnector).toEqual(H.summary);
    expect(shopify.catalogTools.filter((t: any) => t.usable)).toHaveLength(0);
  });

  it("each tool is usable only by its own entitlement; an unmapped tool never is", async () => {
    H.summary = { ...H.summary, grantsAccess: false, status: "error", capabilities: caps({ shopify_order_read: true }) };
    const tools = (await list()).find((e) => e.slug === "shopify").catalogTools;
    const by = Object.fromEntries(tools.map((t: any) => [t.slug, [t.requiredCapability, t.usable]]));
    expect(by).toEqual({
      search_products: ["shopify_catalog_sync", false],
      get_order: ["shopify_order_read", true],
      cancel_order: ["shopify_order_actions", false],
      brand_new_tool: [null, false],
    });
  });

  it("the active Connector: every mapped tool usable", async () => {
    H.summary = { ...H.summary, grantsAccess: true, status: "active", capabilities: caps({ shopify_catalog_sync: true, shopify_order_read: true, shopify_order_actions: true, shopify_storefront_widget: true }) };
    const tools = (await list()).find((e) => e.slug === "shopify").catalogTools;
    expect(tools.filter((t: any) => t.usable).map((t: any) => t.slug)).toEqual(["search_products", "get_order", "cancel_order"]);
  });

  it("other systems are untouched, and nothing is fetched when Shopify is not connected", async () => {
    const hubspot = (await list()).find((e) => e.slug === "hubspot");
    expect(hubspot).not.toHaveProperty("shopifyConnector");
    expect(hubspot.catalogTools[0]).not.toHaveProperty("usable");
    H.connected = false; H.calls = 0;
    const shopify = (await list()).find((e) => e.slug === "shopify");
    expect(shopify).not.toHaveProperty("shopifyConnector");
    expect(H.calls).toBe(0);
  });
});
