/**
 * The cross-customer guard covers WooCommerce (2026-10-13). It ran for
 * Shopify only, so on a Woo store a customer in chat could ask for another
 * customer's order by number and get it. Woo keeps the owner in billing /
 * shipping; a write on an order is checked against the requester BEFORE it
 * runs (a tool can now be set to run without approval).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn() },
  contact: { findFirst: vi.fn() },
  customerVerification: { findMany: vi.fn(async (): Promise<any[]> => []) },
  auditLog: { create: vi.fn(async () => ({})) },
  tenantIntegration: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(async () => ({})) },
}));
vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: prismaMock,
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
  assertPublicUrl: vi.fn(async () => {}),
}));

import { executeAdapterTool } from "../services/connectors/integration-framework";
import { checkResultAllowed, resolveRequesterIdentity, wooOrderOwned } from "../services/connectors/customer-access-guard";
import "../services/connectors/woocommerce.adapter";

const DANA_WA = "972541113421";
const DANA_ORDER = { id: 1001, number: "1001", status: "processing", customer_id: 0, billing: { email: "dana@x.com", phone: "054-111-3421" }, shipping: { phone: "" } };
const NOA_ORDER = { id: 1002, number: "1002", status: "processing", customer_id: 7, billing: { email: "noa@y.com", phone: "052-999-0000" }, shipping: {} };

let calls: Array<{ url: string; method: string }> = [];
function store(byPath: Record<string, unknown>) {
  calls = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const path = new URL(String(url)).pathname.replace("/wp-json/wc/v3", "");
    const body = byPath[`${init?.method ?? "GET"} ${path}`] ?? byPath[path] ?? {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.findFirst.mockResolvedValue({ customerExternalId: DANA_WA });
  prismaMock.contact.findFirst.mockResolvedValue({ phone: "+972541113421", email: null, metadata: {} });
  prismaMock.customerVerification.findMany.mockResolvedValue([]);
  prismaMock.tenantIntegration.findFirst.mockResolvedValue({
    id: "ti1", status: "CONNECTED", credentials: { consumerKey: "ck", consumerSecret: "cs" },
    config: { storeUrl: "https://shop.example.com" }, integration: { slug: "woocommerce" },
  });
});

const run = (tool: string, args: Record<string, unknown>) =>
  executeAdapterTool({ tenantId: "t1", conversationId: "conv1", accessScope: "customer", toolFunctionName: `woocommerce.${tool}`, args });

describe("★ reads on a Woo store, from a customer's chat", () => {
  it("someone else's order by number is denied, and nothing of it leaks", async () => {
    store({ "/orders/1002": NOA_ORDER });
    const r = await run("get_order", { order_id: "1002" });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("access_denied_cross_customer");
    expect(JSON.stringify(r)).not.toContain("noa@y.com");
    expect(prismaMock.auditLog.create.mock.calls.some((c: any[]) => c[0].data.action === "security.cross_customer_access_denied")).toBe(true);
  });

  it("the requester's own order (matched on the billing phone) is returned", async () => {
    store({ "/orders/1001": DANA_ORDER });
    const r = await run("get_order", { order_id: "1001" });
    expect(r.ok).toBe(true);
  });

  it("a list is filtered to the requester's own orders", async () => {
    store({ "/orders": [DANA_ORDER, NOA_ORDER] });
    const r: any = await run("list_orders", {});
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("noa@y.com");
    expect(JSON.stringify(r)).toContain("dana@x.com");
  });

  it("a lookup by someone else's email is refused before the store is called", async () => {
    store({});
    const r = await run("get_customer", { email: "noa@y.com" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("★ writes on an order, from a customer's chat", () => {
  it("someone else's order: nothing is changed (only the ownership read happens)", async () => {
    store({ "/orders/1002": NOA_ORDER });
    const r = await run("update_order_status", { order_id: "1002", status: "cancelled" });
    expect(r.ok).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("the requester's own order: the write goes through", async () => {
    store({ "GET /orders/1001": DANA_ORDER, "PUT /orders/1001": { ...DANA_ORDER, status: "cancelled" } });
    const r = await run("update_order_status", { order_id: "1001", status: "cancelled" });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });
});

describe("the ownership rules", () => {
  it("an order with no owner details is not owned for a write", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    expect(wooOrderOwned(id, { id: 5, billing: {} })).toBe(false);
    expect(wooOrderOwned(id, DANA_ORDER)).toBe(true);
    // A Woo customer_id never proves anything (the identity's ids are Shopify's).
    expect(checkResultAllowed(id, "get_order", { ...NOA_ORDER, customer_id: 27711577588081 }, "woocommerce").allowed).toBe(false);
  });

  it("the internal channel (an agent in the inbox) is not limited to one customer", async () => {
    store({ "/orders/1002": NOA_ORDER });
    const r = await executeAdapterTool({ tenantId: "t1", toolFunctionName: "woocommerce.get_order", args: { order_id: "1002" }, accessScope: "internal" });
    expect(r.ok).toBe(true);
  });
});
