/**
 * GET /api/commerce-context/customers/:contactId/orders - one OrderCard shape
 * for WooCommerce and Shopify, each card saying how the customer was matched.
 * Through the real router; WooCommerce is a fetch double whose `search` is
 * fuzzy, like the real one, so the exact email/phone re-check is exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  conns: {} as Record<string, any>,
  elected: null as string | null,
  wooOrders: [] as any[],
  products: [] as any[],
  shopifyResponse: null as any,
  fetched: [] as string[],
  redis: new Map<string, string>(),
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "agent1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    hasPermission: async () => true,
    assertPublicUrl: async () => undefined,
    getRedis: () => ({
      get: async (k: string) => H.redis.get(k) ?? null,
      set: async (k: string, v: string) => { H.redis.set(k, v); return "OK"; },
    }),
    prisma: {
      contact: {
        findFirst: async (a: any) => (a.where.id === "k1" && a.where.tenantId === "T"
          ? { id: "k1", channel: "WHATSAPP", externalId: "972501234567", email: null, phone: null, personId: "p1" } : null),
        findMany: async (a: any) => (a.where.personId === "p1" && a.where.tenantId === "T" ? [
          { channel: "WHATSAPP", externalId: "972501234567", email: null, phone: null },
          { channel: "INSTAGRAM", externalId: "ig_dana", email: "Dana@Shop.com", phone: null },
        ] : []),
      },
      conversation: { findFirst: async () => ({ id: "conv1" }) },
    },
  };
});
vi.mock("../services/connectors/integration-framework", () => ({
  loadConnection: async ({ slug }: any) => H.conns[slug] ?? null,
  executeAdapterTool: vi.fn(),
}));
vi.mock("../services/connectors/part-systems", () => ({
  getSystemForPart: async () => ({ slug: H.elected, source: H.elected ? "elected" : "unmapped" }),
}));
vi.mock("../services/commerce-context.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, buildCommerceContextResponse: async () => H.shopifyResponse };
});

const WOO = { status: "CONNECTED", config: { storeUrl: "https://shop.example" }, credentials: { consumerKey: "ck", consumerSecret: "cs" } };
const order = (id: number, o: any) => ({
  id, number: String(id), currency: "ILS", total: "100.00", status: "processing",
  date_created_gmt: `2026-10-0${id}T10:00:00`, date_paid_gmt: `2026-10-0${id}T10:05:00`, date_completed_gmt: null,
  billing: { email: "", phone: "" }, line_items: [], refunds: [], ...o,
});

globalThis.fetch = (async (url: string) => {
  H.fetched.push(url);
  const body = url.includes("/products?") ? H.products : H.wooOrders;
  return { ok: true, status: 200, json: async () => body, headers: new Map() } as any;
}) as any;

import router from "../routes/customer-commerce";

const app = express();
app.use("/api/commerce-context/customers", router);
const get = (q = "") => request(app).get(`/api/commerce-context/customers/k1/orders${q}`);

beforeEach(() => {
  H.conns = { woocommerce: WOO };
  H.elected = null;
  H.fetched = [];
  H.redis.clear();
  H.products = [{ id: 77, images: [{ src: "https://img/77.jpg" }] }];
  H.wooOrders = [
    order(1, { billing: { email: "dana@shop.com" }, line_items: [{ id: 11, name: "Linen dress", quantity: 2, price: "50", total: "100", subtotal: "100", product_id: 5, image: { src: "https://img/5.jpg" } }] }),
    order(2, { billing: { phone: "050-123-4567" }, status: "cancelled", line_items: [{ id: 21, name: "Belt", quantity: 1, price: "100", total: "100", subtotal: "100", product_id: 77 }] }),
    order(3, { billing: { email: "dana.other@shop.com", phone: "0529999999" }, status: "completed" }), // fuzzy hit, not her
    order(4, { billing: { email: "DANA@shop.com" }, status: "completed", refunds: [{ id: 9, total: "-30.00" }] }),
  ];
});

describe("WooCommerce", () => {
  it("★ only exact email/phone matches, newest first, each saying HOW it matched", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("woocommerce");
    expect(r.body.orders.map((o: any) => [o.orderNumber, o.matchedBy])).toEqual([["#4", "email"], ["#2", "phone"], ["#1", "email"]]);
  });

  it("★ the card: same chips as Shopify, items with images (line item, else the product), read-only", async () => {
    const r = await get("?locale=he");
    const [o4, o2, o1] = r.body.orders;
    expect(o1).toMatchObject({
      total: { amount: "100.00", currency: "ILS" },
      financial: { key: "paid", label: "שולם" },
      fulfillment: { key: "in_progress" },
      cancelled: false,
      items: [{ title: "Linen dress", quantity: 2, imageUrl: "https://img/5.jpg" }],
      adminUrl: "https://shop.example/wp-admin/post.php?post=1&action=edit",
      eligibility: { cancellable: false, refundable: false, reasonIfNot: "actions_not_supported_for_store" },
    });
    expect(o2).toMatchObject({ cancelled: true, financial: { key: "voided" }, items: [{ imageUrl: "https://img/77.jpg" }] });
    expect(o4).toMatchObject({ fulfillment: { key: "fulfilled" }, refund: { key: "partially_refunded" }, refundedAmount: { amount: "30.00" } });
    expect(o1.detail.lineItems[0]).toMatchObject({ lineItemId: "11", unitPrice: { amount: "50.00" } });
  });

  it("a refunded order that had shipped says shipped, matching its timeline", async () => {
    H.wooOrders = [order(5, { billing: { email: "dana@shop.com" }, status: "refunded", date_completed_gmt: "2026-10-05T12:00:00" })];
    const [o] = (await get()).body.orders;
    expect(o.financial.key).toBe("refunded");
    expect(o.fulfillment.key).toBe("fulfilled");
    expect(o.timeline.find((t: any) => t.key === "fulfilled").reached).toBe(true);
  });

  it("limit, and a second read inside a minute is served from the cache", async () => {
    expect((await get("?limit=1")).body.orders).toHaveLength(1);
    const before = H.fetched.length;
    await get("?limit=1");
    expect(H.fetched.length).toBe(before);
  });

  it("a store error is a stated reason, not an empty history", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any;
    expect((await get()).body).toEqual({ source: null, reason: "store_unreachable", orders: [] });
    globalThis.fetch = (async (url: string) => ({ ok: true, json: async () => (url.includes("/products?") ? H.products : H.wooOrders) })) as any;
  });
});

describe("which store", () => {
  it("★ two connected stores and none chosen: store_not_chosen, never a guess", async () => {
    H.conns.shopify = { status: "CONNECTED", config: {}, credentials: {} };
    expect((await get()).body).toEqual({ source: null, reason: "store_not_chosen", orders: [] });
  });

  it("★ Shopify (elected): the verified panel path, every card matchedBy verified", async () => {
    H.elected = "shopify";
    H.shopifyResponse = { state: "ok", data: { recentOrders: [{ orderId: "s1", orderNumber: "#1001" }] } };
    expect((await get()).body).toEqual({ source: "shopify", state: "ok", orders: [{ orderId: "s1", orderNumber: "#1001", matchedBy: "verified" }] });
  });

  it("Shopify without a verified link passes its state through", async () => {
    H.elected = "shopify";
    H.shopifyResponse = { state: "customer_not_linked" };
    expect((await get()).body).toEqual({ source: "shopify", state: "customer_not_linked", orders: [] });
  });

  it("no store: no_store_connected; unknown contact: 404", async () => {
    H.conns = {};
    expect((await get()).body).toEqual({ source: null, reason: "no_store_connected", orders: [] });
    expect((await request(app).get("/api/commerce-context/customers/nope/orders")).status).toBe(404);
  });
});
