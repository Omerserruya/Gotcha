/**
 * Smoovee prod 2026-11-08 (cmw7r76pj, 11:33): the site sells Alice at ₪262
 * struck through → ₪170.30 (a discount-rules plugin, Flycart / awdr), while
 * the API says price = regular = sale = 262 with on_sale:true. The bot carded
 * 252 and said nothing of the discount. Now the page's main price block is
 * read for products the API marks on sale with no lower price.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, safeFetch: vi.fn(async (url: string) => ({ ok: true, status: 200, text: url.includes("smoovee") ? (url.includes("alice") ? ALICE_PAGE : CHRISTINA_PAGE) : PLAIN_PAGE })) };
});

// Her page's own main price block (2026-11-08), with a related product's price after it.
const ALICE_PAGE = `<html><head><script id='awdr-main-js-extra'>var awdr_params = {"ajaxurl":"x"};</script></head><body><div class="summary"><p class="price"><del><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol" translate="no" dir="auto">&#8362;</span>262</bdi></span></del><br><ins><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol" translate="no" dir="auto">&#8362;</span>170.30</bdi></span></ins></p></div>
<section class="related"><p class="price"><del><bdi>&#8362;15</bdi></del><ins><bdi>&#8362;9.75</bdi></ins></p></section></body></html>`;

// Her pages carry the plugin's markers (awdr_params, awdr-main-js-extra).
const CHRISTINA_PAGE = `<script id="awdr-main-js-extra">var awdr_params = {};</script><p class="price"><del><bdi>&#8362;219</bdi></del><ins><bdi>&#8362;142.35</bdi></ins></p>`;
const PLAIN_PAGE = `<p class="price"><span class="amount"><bdi>&#8362;99</bdi></span></p>`;

import { parseRenderedDiscount, hiddenSale, renderedDiscount, discountFor, hasRuleDiscountMarkers } from "../services/woo-rendered-price.service";
import { normalizeWooProducts, applyDiscount, buildKeyedModelSummary } from "../services/product-search.service";

describe("the store's discount, from its own page", () => {
  it("her main price block: was 262, now 170.30 (not the related product's)", () => {
    expect(parseRenderedDiscount(ALICE_PAGE)).toEqual({ was: 262, now: 170.3 });
  });
  it("no del/ins, or no lower price: nothing", () => {
    expect(parseRenderedDiscount('<p class="price"><bdi>₪262</bdi></p>')).toBeNull();
    expect(parseRenderedDiscount('<p class="price"><del><bdi>₪100</bdi></del><ins><bdi>₪120</bdi></ins></p>')).toBeNull();
    expect(parseRenderedDiscount("<p>no price</p>")).toBeNull();
  });
  it("only a product the API marks on sale with no lower price is read", () => {
    expect(hiddenSale({ on_sale: true, regular_price: "262", sale_price: "262" })).toBe(true);
    expect(hiddenSale({ on_sale: true, regular_price: "262", sale_price: "" })).toBe(true);
    expect(hiddenSale({ on_sale: true, regular_price: "262", sale_price: "200" })).toBe(false); // the API already says it
    expect(hiddenSale({ on_sale: false, regular_price: "262", sale_price: "262" })).toBe(false);
  });
  it("read once per page for ten minutes, with one [woo-discount] line per read", async () => {
    const { safeFetch } = await import("@chatcenter/shared") as any;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = safeFetch.mock.calls.length;
    expect(await renderedDiscount("https://smoovee-ltd.com/he/product/alice/")).toEqual({ was: 262, now: 170.3 });
    await renderedDiscount("https://smoovee-ltd.com/he/product/alice/");
    expect(safeFetch.mock.calls.length - before).toBe(1);
    expect(log.mock.calls.flat().filter((l) => String(l).startsWith("[woo-discount]"))).toEqual(["[woo-discount] /he/product/alice/ was=262 now=170.3"]);
    log.mockRestore();
  });
});

describe("what the model and the card get", () => {
  it("the model: DISCOUNT was / now, and the rule never to work out a percentage", () => {
    const env = normalizeWooProducts([{ id: 4057, name: "סמובי אליס", status: "publish", price: "262", stock_status: "instock", permalink: "https://smoovee-ltd.com/he/product/alice/" }], { storeUrl: "https://smoovee-ltd.com", storeCurrency: "ILS" });
    env.candidates = env.candidates.map((c) => applyDiscount(c, "262", "170.30"));
    const s = buildKeyedModelSummary(env, "he", true);
    expect(s).toMatch(/PRODUCT_1: "סמובי אליס" \| ILS 170\.30 \| DISCOUNT: was ILS 262, now ILS 170\.30/);
    expect(s).toMatch(/Never state or work out a percentage/);
    expect(env.candidates[0].price).toBe("170.30");
  });
  it("grounding reads it for the first five products; the card gets price and compareAtPrice", () => {
    const g = readFileSync(join(__dirname, "../services/discovery-integration.service.ts"), "utf8");
    expect(g).toContain("if (i >= 5) return c;");
    expect(g).toContain("await discountFor(byId.get(c.productId), c.url)");
    const w = readFileSync(join(__dirname, "../services/woo-chat-turn.service.ts"), "utf8");
    expect(w).toContain("const d = await discountFor(raw, card.productUrl)");
    expect(w).toContain("card.compareAtPrice = was;");
    expect(w).toContain("card.variants.every((v) => Number(v.price) === d.was)");
  });
});

describe("a store that prices by rules (prod 13:04: wc/v3 says on_sale:false, every card had no discount)", () => {
  it("her markers are recognised; a plain page is not", () => {
    expect(hasRuleDiscountMarkers(ALICE_PAGE)).toBe(true);
    expect(hasRuleDiscountMarkers(PLAIN_PAGE)).toBe(false);
  });
  it("on her store a product with on_sale:false still gets its page price", async () => {
    const d = await discountFor({ on_sale: false, regular_price: "219", sale_price: "" }, "https://smoovee-ltd.com/he/product/christina/");
    expect(d).toEqual({ was: 219, now: 142.35 });
  });
  it("a store without the plugin: one page read a day to learn so, then no price reads", async () => {
    const { safeFetch } = await import("@chatcenter/shared") as any;
    const before = safeFetch.mock.calls.length;
    const plain = { on_sale: false, regular_price: "99", sale_price: "" };
    expect(await discountFor(plain, "https://plain.example.com/p/a/")).toBeNull();
    expect(await discountFor(plain, "https://plain.example.com/p/b/")).toBeNull();
    expect(await discountFor(plain, "https://plain.example.com/p/c/")).toBeNull();
    expect(safeFetch.mock.calls.length - before).toBe(1);
  });
});
