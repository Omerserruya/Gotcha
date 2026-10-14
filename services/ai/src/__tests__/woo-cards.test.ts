/**
 * ★ W9 phase b, through the real routes and the real staging service (the
 * store's answers and the database are doubles):
 *   - the bootstrap serves products on only when the widget turned them on
 *     AND the Woo store is connected
 *   - staging re-reads every product from the store: an invented id, a hidden
 *     or draft product gets no card; a variable product carries its variations
 *   - the poll gives the visitor the projected cards, never the stored
 *     metadata, and nothing from another widget or a store no longer connected
 *   - the settings save and return the widget's commerce (opt-in)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const STORE = "https://demo-store.example.com";
const H = vi.hoisted(() => ({
  accounts: [] as any[], conv: null as any, integration: null as any, messages: [] as any[],
  products: {} as Record<string, any>, variations: {} as Record<string, any[]>, adapterCalls: [] as any[],
}));

vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]: [string, any]) =>
    v && typeof v === "object" && "in" in v ? v.in.includes(r[k]) : r[k] === v);
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    readDurableSetting: async () => null,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _r: any, n: any) => n(),
    requirePermission: () => (_q: any, _r: any, n: any) => n(),
    getRedis: () => ({ get: async () => null, set: async () => "OK" }),
    prisma: {
      channelAccount: {
        findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null,
        findMany: async (a: any) => H.accounts.filter((r) => match(r, a.where)),
        update: async (a: any) => { const r = H.accounts.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
      },
      conversation: {
        findFirst: async (a: any) => (H.conv && H.conv.id === a.where.id && H.conv.tenantId === a.where.tenantId ? H.conv : null),
        findUnique: async (a: any) => (H.conv && H.conv.id === a.where.id ? H.conv : null),
      },
      tenantIntegration: {
        findFirst: async (a: any) => (H.integration && a.where.tenantId === "T" && (!a.where.status || a.where.status === H.integration.status) ? H.integration : null),
        update: async () => ({}),
      },
      message: { findMany: async () => H.messages },
      whatsAppNumber: { findMany: async () => [] },
      flowCanvas: { findUnique: async () => null },
      shopifyChatInstallation: { findMany: async () => [] },
      $executeRaw: async () => 1,
    },
  };
});
vi.mock("../services/connectors/integration-framework", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  loadConnection: async () => ({ tenantIntegrationId: "ti_woo", credentials: {}, config: { storeUrl: STORE, storeCurrency: "ILS" }, status: "CONNECTED", expiresAt: null }),
  executeAdapterTool: async (o: any) => {
    H.adapterCalls.push(o);
    if (o.toolFunctionName === "woocommerce.get_product") {
      const p = H.products[String(o.args.product_id)];
      return p ? { ok: true, result: p } : { ok: false, failure: "errored", reason: "woocommerce_404" };
    }
    if (o.toolFunctionName === "woocommerce.list_product_variations") return { ok: true, result: H.variations[String(o.args.product_id)] ?? [] };
    return { ok: false, failure: "refused", reason: "unexpected" };
  },
}));

import { normalizeWebchatConfig } from "@chatcenter/shared";
import chat from "../routes/embedded-chat";
import widget from "../routes/website-widget";
import { prepareWebchatCommerceTurn, withoutOtherStoreTools, cardsMatchTurn } from "../services/woo-chat-turn.service";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", chat); a.use("/api/website-widget", widget); return a; };
const web = (commerce: any = { productMessagingEnabled: true, addToCartEnabled: true }) => ({
  id: "ca_web", tenantId: "T", channel: "WEBCHAT", externalId: "widget-1", connectionStatus: "CONNECTED", platformMeta: null, lastHealthCheck: new Date(),
  credentials: normalizeWebchatConfig({ v: 2, commerce }),
});
const product = (id: number, o: any = {}) => ({ id, slug: `p${id}`, name: `Product ${id}`, status: "publish", catalog_visibility: "visible", type: "simple", price: "100", regular_price: "100", sale_price: "", stock_status: "instock", purchasable: true, permalink: `${STORE}/product/p${id}/`, images: [], ...o });
const boot = async () => (await request(app()).post("/api/embedded-chat/bootstrap").send({ widgetId: "widget-1" })).body.data.widget;

beforeEach(() => {
  H.accounts = [web()];
  H.conv = { id: "conv1", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "tok_1", customerName: "V" };
  H.integration = { status: "CONNECTED", config: { storeUrl: STORE } };
  H.messages = []; H.adapterCalls = [];
  H.products = { "41": product(41), "42": product(42, { status: "draft" }), "43": product(43, { catalog_visibility: "hidden" }), "50": product(50, { type: "variable", attributes: [{ name: "Size", variation: true }] }) };
  H.variations = { "50": [{ id: 51, status: "publish", price: "90", regular_price: "90", stock_status: "instock", attributes: [{ name: "Size", option: "M" }] }] };
});

describe("★ the bootstrap's product flags", () => {
  it("on only when the widget turned them on AND the store is connected", async () => {
    expect((await boot()).features).toMatchObject({ productMessaging: true, addToCart: true });
    H.integration = { status: "ERROR", config: { storeUrl: STORE } };
    expect((await boot()).features).toMatchObject({ productMessaging: false, addToCart: false });
    H.integration = { status: "CONNECTED", config: { storeUrl: STORE } };
    H.accounts = [web({ productMessagingEnabled: false })];
    expect((await boot()).features).toMatchObject({ productMessaging: false, addToCart: false });
  });
});

describe("★ staging cards from the store", () => {
  it("re-read from the store; an invented, draft or hidden product gets no card; a variable one carries its variations", async () => {
    const turn = (await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "conv1" }))!;
    const r = await turn.sendShopifyProducts({ products: [{ productId: "41", reason: "in budget" }, { productId: "42" }, { productId: "43" }, { productId: "999" }, { productId: "50" }] });
    expect(r).toEqual({ ok: true, products: [
      { title: "Product 41", price: "100", currency: "ILS", available: true },
      { title: "Product 50", price: "100", currency: "ILS", available: true },
    ] });
    expect(turn.staged).toHaveLength(1);
    const st = turn.staged[0]!;
    expect(st.messageType).toBe("woo_product_carousel");
    expect(st.metadata).toMatchObject({ source: "ai_bot", commerce: { kind: "woo_commerce", storeUrl: STORE, channelAccountId: "ca_web", addToCartEnabled: true } });
    const cards = (st.metadata as any).commerce.products;
    expect(cards[0]).toMatchObject({ productId: "41", reason: "in budget", selectedVariantId: "41" });
    expect(cards[1].variants).toEqual([expect.objectContaining({ variantId: "51", title: "M", price: "90" })]);
    expect(H.adapterCalls.every((c) => c.accessScope === "internal")).toBe(true);
  });

  it("a non-numeric id is never sent to the store; none left is a refusal", async () => {
    const turn = (await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "conv1" }))!;
    expect(await turn.sendShopifyProducts({ products: [{ productId: "../orders" }, { handle: "oak" }] })).toMatchObject({ ok: false });
    expect(H.adapterCalls).toEqual([]);
    expect(await turn.sendShopifyProducts({ products: [{ productId: "42" }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/no_matching_products/) });
    expect(turn.staged).toEqual([]);
  });

  it("no turn: products off, store not connected, not a web chat", async () => {
    H.accounts = [web({ productMessagingEnabled: false })];
    expect(await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "conv1" })).toBeNull();
    H.accounts = [web()];
    H.integration = null;
    expect(await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "conv1" })).toBeNull();
    H.integration = { status: "CONNECTED", config: { storeUrl: STORE } };
    H.conv = { ...H.conv, channel: "WHATSAPP" };
    expect(await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "conv1" })).toBeNull();
  });
});

describe("★ the poll projects the cards", () => {
  const cardMeta = (o: any = {}) => ({ source: "ai_bot", commerce: { kind: "woo_commerce", storeUrl: STORE, channelAccountId: "ca_web", addToCartEnabled: true, source: "ai",
    products: [{ productId: "41", handle: "p41", title: "Product 41", imageUrl: null, productUrl: `${STORE}/product/p41/`, currency: "ILS", price: "100", compareAtPrice: null, available: true, published: true, selectedVariantId: "41", optionNames: [], reason: null, variants: [] }], ...o } });
  const poll = () => request(app()).get("/api/embedded-chat/messages/conv1").query({ token: "tok_1" });

  it("this widget's card from the connected store: projected; the stored metadata never leaves", async () => {
    H.messages = [{ id: "m1", direction: "OUTBOUND", body: "Product 41 - 100 ILS", senderName: "AI Bot", createdAt: new Date(), metadata: cardMeta() },
      { id: "m2", direction: "INBOUND", body: "hi", senderName: "V", createdAt: new Date(), metadata: { internal: "secret" } }];
    const r = await poll();
    expect(r.status).toBe(200);
    expect(r.body.data[0].commerce).toMatchObject({ addToCartEnabled: true, products: [expect.objectContaining({ productId: "41", title: "Product 41" })] });
    expect(r.body.data[1].commerce).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/metadata|secret|woo_commerce|ca_web/);
  });

  it("★ another widget's card, or a store no longer connected: no card", async () => {
    H.messages = [{ id: "m1", direction: "OUTBOUND", body: "x", senderName: "AI Bot", createdAt: new Date(), metadata: cardMeta({ channelAccountId: "ca_other" }) }];
    expect((await poll()).body.data[0].commerce).toBeNull();
    H.messages = [{ id: "m1", direction: "OUTBOUND", body: "x", senderName: "AI Bot", createdAt: new Date(), metadata: cardMeta() }];
    H.integration = null;
    expect((await poll()).body.data[0].commerce).toBeNull();
  });
});

describe("the widget's commerce in settings", () => {
  it("saved through PUT, normalised (cart needs cards), returned by GET", async () => {
    H.accounts = [web({ productMessagingEnabled: false })];
    let r = await request(app()).put("/api/website-widget").send({ commerce: { addToCartEnabled: true } });
    expect(r.body.data.settings.commerce).toEqual({ productMessagingEnabled: false, addToCartEnabled: false, promotions: { couponIds: [] } });
    r = await request(app()).put("/api/website-widget").send({ commerce: { productMessagingEnabled: true, addToCartEnabled: true, promotions: { couponIds: ["7", "x"] } } });
    expect(r.body.data.settings.commerce).toEqual({ productMessagingEnabled: true, addToCartEnabled: true, promotions: { couponIds: ["7"] } });
    expect((await request(app()).get("/api/website-widget")).body.data.settings.commerce.productMessagingEnabled).toBe(true);
  });
});

describe("★ one store per web chat turn", () => {
  const tools = ["shopify.search_products", "shopify.get_product", "woocommerce.list_products", "shopify.get_order", "escalate"].map((name) => ({ function: { name } }));
  it("with a Woo turn the Shopify catalogue tools are hidden (orders stay); without one, nothing changes", async () => {
    const turn = await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "conv1" });
    expect(withoutOtherStoreTools(tools, turn).map((t) => t.function.name)).toEqual(["woocommerce.list_products", "shopify.get_order", "escalate"]);
    expect(withoutOtherStoreTools(tools, null)).toEqual(tools);
  });
  it("cards only from the store the search read", async () => {
    const turn = await prepareWebchatCommerceTurn({ tenantId: "T", conversationId: "conv1" });
    expect(cardsMatchTurn("woocommerce", turn)).toBe(true);
    expect(cardsMatchTurn("shopify", turn)).toBe(false);
    expect(cardsMatchTurn("shopify", null)).toBe(true);
    expect(cardsMatchTurn("woocommerce", null)).toBe(false);
  });
});

describe("★ POST /cart/validate (phase c)", () => {
  const cart = (body: any) => request(app()).post("/api/embedded-chat/cart/validate").send({ sessionId: "conv1", sessionToken: "tok_1", ...body });

  it("a simple product: the store's own add-to-cart link, checked against the store", async () => {
    const r = await cart({ productId: "41", variantId: "41", quantity: 3 });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ cartUrl: `${STORE}/?add-to-cart=41&quantity=3`, productId: "41", variantId: "41", quantity: 3 });
    expect(H.adapterCalls.map((c) => [c.toolFunctionName, c.accessScope])).toEqual([["woocommerce.get_product", "internal"]]);
  });

  it("a variation of this product; one that is not its own is refused", async () => {
    expect((await cart({ productId: "50", variantId: "51", quantity: 1 })).body.data.cartUrl).toBe(`${STORE}/?add-to-cart=50&variation_id=51&quantity=1`);
    expect((await cart({ productId: "50", variantId: "999" })).body).toEqual({ error: "variant_not_found" });
    expect((await cart({ productId: "50" })).body).toEqual({ error: "choose_variant" });
  });

  it("★ refused: a draft or hidden product (422), an unknown one (404), junk ids (400), a wrong session (404)", async () => {
    expect((await cart({ productId: "42" })).body).toEqual({ error: "not_for_sale" });
    expect((await cart({ productId: "43" })).body).toEqual({ error: "not_for_sale" });
    expect((await cart({ productId: "999" })).status).toBe(404);
    expect((await cart({ productId: "41;drop" })).status).toBe(400);
    expect((await cart({ productId: "41", sessionToken: "guess" })).status).toBe(404);
  });

  it("★ the switch off or the store not connected: 403 cart_disabled, the store never asked", async () => {
    H.accounts = [web({ productMessagingEnabled: true, addToCartEnabled: false })];
    expect((await cart({ productId: "41" })).body).toEqual({ error: "cart_disabled" });
    H.accounts = [web()];
    H.integration = null;
    expect((await cart({ productId: "41" })).status).toBe(403);
    expect(H.adapterCalls).toEqual([]);
  });
});
