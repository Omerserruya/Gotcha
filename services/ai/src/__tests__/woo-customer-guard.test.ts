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
  autoLinkByShopifyCustomer: vi.fn(async () => ({ outcome: "no_match" })),
  autoLinkByIdentifier: vi.fn(async () => ({ outcome: "linked", targetContactId: "c_other" })),
}));

import { executeAdapterTool, __resetRateLimits } from "../services/connectors/integration-framework";
import { checkResultAllowed, resolveRequesterIdentity, wooOrderOwned, linkFromWooOrders } from "../services/connectors/customer-access-guard";
import { orderPhoneSearchTerms } from "../services/connectors/woocommerce.adapter";
import { autoLinkByIdentifier } from "@chatcenter/shared";
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
  __resetRateLimits();
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

describe("★ the new order-scoped tools are owner-checked first (2026-10-13)", () => {
  for (const [tool, args] of [
    ["list_refunds", { order_id: "1002" }],
    ["list_order_notes", { order_id: "1002" }],
    ["get_shipment_tracking", { order_id: "1002" }],
    ["create_refund", { order_id: "1002", amount: "10" }],
    ["cancel_order", { order_id: "1002" }],
    ["add_order_note", { order_id: "1002", note: "x" }],
    ["update_shipping_address", { order_id: "1002", address_1: "a", city: "b" }],
  ] as const) {
    it(`${tool} on someone else's order: refused after the ownership read only`, async () => {
      store({ "/orders/1002": NOA_ORDER });
      const r = await run(tool, args as any);
      expect(r.ok).toBe(false);
      expect((r as any).reason).toContain("access_denied_cross_customer");
      expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname.split("/v3")[1]}`)).toEqual(["GET /orders/1002"]);
    });
  }

  it("refunds of the requester's own order are returned", async () => {
    store({ "/orders/1001": DANA_ORDER, "/orders/1001/refunds": [{ id: 1, amount: "10.00" }] });
    const r = await run("list_refunds", { order_id: "1001" });
    expect(r.ok).toBe(true);
  });
});

// ─── Guest orders, by the customer's own phone and email (2026-10-14) ───

/** A store that answers Woo's order search as Woo does: a substring of billing/shipping. */
function searchingStore(orders: any[]) {
  calls = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const u = new URL(String(url));
    const q = u.searchParams.get("search");
    const body = q == null ? orders : orders.filter((o) => [o.billing?.email, o.billing?.phone, o.shipping?.phone].some((f) => String(f ?? "").includes(q)));
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });
}
const searched = () => calls.map((c) => new URL(c.url).searchParams.get("search"));

describe("★ guest orders are found by the customer's own phone, however the store saved it", () => {
  const guest = (phone: string, o: any = {}) => ({ id: 575, number: "575", status: "processing", customer_id: 0, date_created_gmt: "2026-10-14T11:45:00", billing: { email: "other@gmail.com", phone }, shipping: {}, ...o });

  it("no arguments: searched by the sender's own phone (every stored form) and found", async () => {
    for (const stored of ["0541113421", "+972541113421", "054-111-3421", "+972 54-111-3421", "054 111 3421"]) {
      searchingStore([guest(stored)]);
      const r: any = await run("list_customer_orders", {});
      expect(r.ok, stored).toBe(true);
      expect(r.result.map((o: any) => o.id), stored).toEqual([575]);
    }
    expect(searched()).toEqual(["541113421", "54-111-3421", "54 111 3421"]);
  });

  it("the sender's stored email is searched too, merged and de-duplicated, newest first", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ phone: "+972541113421", email: "dana@x.com", metadata: {} });
    searchingStore([guest("0541113421"), { ...DANA_ORDER, id: 900, date_created_gmt: "2026-09-01T10:00:00" }, guest("0541113421", { id: 576, date_created_gmt: "2026-10-14T12:00:00" })]);
    const r: any = await run("list_customer_orders", {});
    expect(r.result.map((o: any) => o.id)).toEqual([576, 575, 900]);
    expect(searched()).toContain("dana@x.com");
  });

  it("★ another customer's order that the fuzzy search also returned is filtered out", async () => {
    searchingStore([guest("0541113421"), { ...NOA_ORDER, billing: { ...NOA_ORDER.billing, phone: "0541113421-9" } }]);
    const r: any = await run("list_customer_orders", {});
    expect(r.result.map((o: any) => o.id)).toEqual([575]);
    expect(JSON.stringify(r)).not.toContain("noa@y.com");
  });

  it("★ a phone typed for someone else is refused before the store is asked", async () => {
    searchingStore([NOA_ORDER]);
    const r = await run("list_customer_orders", { phone: "052-999-0000" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("the search terms for a phone", () => {
    expect(orderPhoneSearchTerms("+972 54-568-0665")).toEqual(["545680665", "54-568-0665", "54 568 0665"]);
    expect(orderPhoneSearchTerms("03-555-1234")).toEqual(["035551234"]);
    expect(orderPhoneSearchTerms("12345")).toEqual([]);
    expect(orderPhoneSearchTerms(undefined)).toEqual([]);
  });
});

describe("★ a guest order's other identifier links the contact the shared way", () => {
  it("the checkout email of an order the requester owns is fed to autoLinkByIdentifier; a foreign order's never", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: "c_dana", phone: "+972541113421", email: null, metadata: {} });
    const identity = (await resolveRequesterIdentity("t1", "conv1"))!;
    const own = { id: 575, billing: { email: "Dana.Other@Gmail.com", phone: "0541113421" }, shipping: {} };
    expect(await linkFromWooOrders("t1", "conv1", identity, [own, NOA_ORDER])).toBe(1);
    expect((autoLinkByIdentifier as any).mock.calls).toEqual([[{ tenantId: "t1", senderContactId: "c_dana", identifier: { type: "email", value: "dana.other@gmail.com" } }]]);
  });

  it("nothing new on the order: nothing linked", async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ id: "c_dana", phone: "+972541113421", email: "dana@x.com", metadata: {} });
    const identity = (await resolveRequesterIdentity("t1", "conv1"))!;
    expect(await linkFromWooOrders("t1", "conv1", identity, [DANA_ORDER])).toBe(0);
    expect(autoLinkByIdentifier).not.toHaveBeenCalled();
  });

  it("the denial log names the Woo tool as woocommerce.*", async () => {
    store({ "/orders/1002": NOA_ORDER });
    await run("get_order", { order_id: "1002" });
    const row: any = (prismaMock.auditLog.create.mock.calls as any[]).find((c: any[]) => c[0].data.action === "security.cross_customer_access_denied")![0];
    expect(row.data.metadata.tool).toBe("woocommerce.get_order");
  });
});
