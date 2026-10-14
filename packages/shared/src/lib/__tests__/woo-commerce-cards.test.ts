/**
 * ★ W9 phase b: WooCommerce product cards for the website widget.
 *   - a card only for what the store sells on its own page (published, not
 *     hidden, simple or variable); the link only on the store's host
 *   - the visitor gets the same shape as a Shopify card, only from this
 *     store and this widget
 *   - products are opt-in on the widget, and served only while the store is connected
 */
import { describe, it, expect } from "vitest";
import { buildWooProductCard, projectWooCommerce, summarizeWooCards } from "../woo-commerce-cards";
import { normalizeWebchatConfig, publicWebchatConfig } from "../webchat-widget";

const STORE = "https://demo-store.example.com";
const simple = (o: any = {}) => ({
  id: 41, slug: "oak-lamp", name: "Oak Lamp", status: "publish", catalog_visibility: "visible", type: "simple",
  price: "129.90", regular_price: "149.90", sale_price: "129.90", stock_status: "instock", purchasable: true,
  permalink: `${STORE}/product/oak-lamp/`, images: [{ src: `${STORE}/wp-content/uploads/oak.jpg` }], ...o,
});
const variable = (o: any = {}) => simple({ id: 50, slug: "tee", name: "Tee", type: "variable", price: "99", regular_price: "", sale_price: "",
  attributes: [{ name: "Size", variation: true, options: ["S", "M"] }, { name: "Material", variation: false }], ...o });
const variation = (id: number, size: string, o: any = {}) => ({ id, status: "publish", price: "99", regular_price: "99", sale_price: "", stock_status: "instock", purchasable: true, attributes: [{ name: "Size", option: size }], ...o });

describe("★ buildWooProductCard", () => {
  it("a simple product: itself as its one purchasable variant, on sale with the old price", () => {
    expect(buildWooProductCard(simple(), null, { storeUrl: STORE, currency: "ILS", reason: "matches your budget" })).toEqual({
      productId: "41", handle: "oak-lamp", title: "Oak Lamp", imageUrl: `${STORE}/wp-content/uploads/oak.jpg`,
      productUrl: `${STORE}/product/oak-lamp/`, currency: "ILS", price: "129.90", compareAtPrice: "149.90", available: true,
      published: true, selectedVariantId: "41", optionNames: [], reason: "matches your budget",
      variants: [{ variantId: "41", title: "Oak Lamp", price: "129.90", compareAtPrice: "149.90", available: true, options: [], requiresSellingPlan: false }],
    });
  });

  it("a variable product: its variations, the option names that vary, no preselected variant", () => {
    const c = buildWooProductCard(variable(), [variation(51, "S"), variation(52, "M", { stock_status: "outofstock" }), variation(53, "L", { status: "private" })], { storeUrl: STORE, currency: "ILS" })!;
    expect(c.optionNames).toEqual(["Size"]);
    expect(c.selectedVariantId).toBeNull();
    expect(c.variants.map((v) => [v.variantId, v.title, v.available])).toEqual([["51", "S", true], ["52", "M", false]]);
    expect(c.available).toBe(true);
    expect(buildWooProductCard(variable(), [variation(52, "M", { stock_status: "outofstock" })], { storeUrl: STORE, currency: null })!.available).toBe(false);
  });

  it("★ nothing the store would not sell on its own page; a link off the store is replaced", () => {
    for (const o of [{ status: "draft" }, { catalog_visibility: "hidden" }, { type: "external" }, { type: "grouped" }, { id: null }]) {
      expect(buildWooProductCard(simple(o), null, { storeUrl: STORE, currency: "ILS" })).toBeNull();
    }
    const c = buildWooProductCard(simple({ permalink: "https://evil.example.com/x", images: [{ src: "http://insecure.example.com/a.jpg" }] }), null, { storeUrl: STORE, currency: "ILS" })!;
    expect(c.productUrl).toBe(`${STORE}/?p=41`);
    expect(c.imageUrl).toBeNull();
    expect(buildWooProductCard(simple({ stock_status: "outofstock" }), null, { storeUrl: STORE, currency: "ILS" })!.available).toBe(false);
  });
});

describe("★ projectWooCommerce", () => {
  const card = buildWooProductCard(simple(), null, { storeUrl: STORE, currency: "ILS" })!;
  const meta = { source: "ai_bot", commerce: { kind: "woo_commerce", storeUrl: STORE, channelAccountId: "ca_web", products: [card], addToCartEnabled: true, source: "ai" } };

  it("this store and this widget: the card in the widget's shape", () => {
    const v = projectWooCommerce(meta, { storeUrl: STORE + "/", channelAccountId: "ca_web" })!;
    expect(v.addToCartEnabled).toBe(true);
    expect(v.products[0]).toMatchObject({ productId: "41", title: "Oak Lamp", price: "129.90", published: true, selectedVariantId: "41" });
  });

  it("★ another store, another widget, no connected store, a Shopify payload, nothing: null", () => {
    expect(projectWooCommerce(meta, { storeUrl: "https://other.example.com", channelAccountId: "ca_web" })).toBeNull();
    expect(projectWooCommerce(meta, { storeUrl: STORE, channelAccountId: "ca_other" })).toBeNull();
    expect(projectWooCommerce(meta, { storeUrl: null, channelAccountId: "ca_web" })).toBeNull();
    expect(projectWooCommerce({ shopify: { kind: "shopify_commerce" } }, { storeUrl: STORE, channelAccountId: "ca_web" })).toBeNull();
    expect(projectWooCommerce({ commerce: { ...meta.commerce, products: [] } }, { storeUrl: STORE, channelAccountId: "ca_web" })).toBeNull();
    expect(projectWooCommerce(null, { storeUrl: STORE, channelAccountId: "ca_web" })).toBeNull();
  });

  it("the card's text line for the inbox", () => {
    expect(summarizeWooCards([card])).toBe("Oak Lamp - 129.90 ILS");
  });
});

describe("★ the widget's products are opt-in and need the store", () => {
  it("off by default; add to cart needs cards; coupon ids sanitised and capped", () => {
    expect(normalizeWebchatConfig(null).commerce).toEqual({ productMessagingEnabled: false, addToCartEnabled: false, promotions: { couponIds: [] } });
    expect(normalizeWebchatConfig({ v: 2, commerce: { addToCartEnabled: true } }).commerce.addToCartEnabled).toBe(false);
    const c = normalizeWebchatConfig({ v: 2, commerce: { productMessagingEnabled: true, addToCartEnabled: true, promotions: { couponIds: [12, "13", "13", "x1", "<b>", "14", "15", "16", "17"] } } }).commerce;
    expect(c).toEqual({ productMessagingEnabled: true, addToCartEnabled: true, promotions: { couponIds: ["12", "13", "14", "15", "16"] } });
  });

  it("★ served on only while the store is connected", () => {
    const on = normalizeWebchatConfig({ v: 2, commerce: { productMessagingEnabled: true, addToCartEnabled: true } });
    expect(publicWebchatConfig(on, { offline: false, storeConnected: true }).features).toMatchObject({ productMessaging: true, addToCart: true });
    expect(publicWebchatConfig(on, { offline: false, storeConnected: false }).features).toMatchObject({ productMessaging: false, addToCart: false });
    expect(publicWebchatConfig(normalizeWebchatConfig(null), { offline: false, storeConnected: true }).features).toMatchObject({ productMessaging: false, addToCart: false });
  });
});
