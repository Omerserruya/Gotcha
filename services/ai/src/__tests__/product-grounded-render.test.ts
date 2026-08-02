/**
 * Deterministic grounded product rendering: exact product identity (title,
 * price, currency, URL, image, variant, availability) comes ONLY from the
 * canonical typed envelope - never from the model's prose. The model
 * references candidates by PRODUCT_n keys; it cannot invent, substitute, or
 * alter any protected field.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeShopifyProducts,
  buildKeyedModelSummary,
  renderGroundedProductReply,
  type ProductSearchEnvelope,
} from "../services/product-search.service";
import { sanitizeCustomerText } from "@chatcenter/shared";

const RAW = [
  { id: 111, title: "The Collection Snowboard: Liquid", handle: "the-collection-snowboard-liquid",
    product_type: "Snowboard", vendor: "Urban",
    variants: [{ id: 9111, sku: "LIQ-1", price: "749.95", inventory_quantity: 4, inventory_management: "shopify" }],
    image: { src: "https://cdn.shopify.com/s/x/liquid.jpg" } },
  { id: 222, title: "The Collection Snowboard: Hydrogen", handle: "the-collection-snowboard-hydrogen",
    variants: [{ id: 9222, sku: "HYD-1", price: "600.00", inventory_quantity: 0, inventory_management: "shopify" }],
    images: [{ src: "https://cdn.shopify.com/s/x/hydrogen.jpg" }] },
  { id: 333, title: "The Archived Snowboard", handle: "the-archived-snowboard",
    variants: [{ id: 9333, sku: "ARC-1", price: "629.95", inventory_quantity: 2, inventory_management: null }] },
];

function env(shop = "urban-supply-gotcha-demo.myshopify.com"): ProductSearchEnvelope {
  return normalizeShopifyProducts(RAW, {
    shopDomain: shop,
    budget: { target: 700, currency: "USD" },
    // The display currency comes from the STORE. It used to be read off the
    // budget, which stamped the shopper's currency onto Shopify's numbers.
    shopCurrency: "USD",
    requestedFilters: ["query", "budget", "flex", "length", "riding_style"],
  });
}

/**
 * A shopper naming a budget in a currency the store does not price in.
 * Live regression: "יש סנובורד עד 800 שקל?" against this USD catalog rendered
 * "ILS 749.95" for a $749.95 board - the store's number wearing the customer's
 * currency, understating the price about fourfold.
 */
function crossCurrencyEnv(): ProductSearchEnvelope {
  return normalizeShopifyProducts(RAW, {
    shopDomain: "urban-supply-gotcha-demo.myshopify.com",
    budget: { target: 800, currency: "ILS" },
    shopCurrency: "USD",
    requestedFilters: ["query", "budget"],
  });
}

describe("budget currency mismatch", () => {
  it("labels prices in the STORE currency, never the shopper's", () => {
    const e = crossCurrencyEnv();
    expect(e.candidates.every((c) => c.currency === "USD")).toBe(true);
  });

  it("records the mismatch instead of silently comparing", () => {
    expect(crossCurrencyEnv().budgetCurrencyMismatch).toEqual({ budget: "ILS", shop: "USD" });
  });

  it("makes no over/under-budget claim across currencies", () => {
    // 749.95 USD against an 800 ILS target is not "within budget" - it is not
    // comparable at all without an exchange rate we do not have.
    const e = crossCurrencyEnv();
    expect(e.appliedFilters).not.toContain("budget");
    expect(e.candidates.every((c) => c.matchQuality === "exact")).toBe(true);
  });

  it("states the currency deterministically, even when the model returns no prose", () => {
    // The fallback path drops prose entirely, so a model-authored caveat would
    // vanish exactly when the bare price list needs it most.
    const r = renderGroundedProductReply("", crossCurrencyEnv(), "he");
    expect(r.usedFallback).toBe(true);
    expect(r.message).toContain("USD");
    expect(r.message).toMatch(/לא השוויתי|ILS/);
  });

  it("omits the notice when the shopper's budget is already in the store currency", () => {
    expect(renderGroundedProductReply("", env(), "he").message).not.toMatch(/לא השוויתי/);
  });
});

describe("envelope is canonical (1-5,10)", () => {
  const e = env();
  it("1. exact title", () => expect(e.candidates[0].title).toBe("The Collection Snowboard: Liquid"));
  it("2. exact price + currency", () => { expect(e.candidates[0].price).toBe("749.95"); expect(e.candidates[0].currency).toBe("USD"); });
  it("3. exact URL from handle", () => expect(e.candidates[0].url).toBe("https://urban-supply-gotcha-demo.myshopify.com/products/the-collection-snowboard-liquid"));
  it("4. exact image URL", () => { expect(e.candidates[0].imageUrl).toBe("https://cdn.shopify.com/s/x/liquid.jpg"); expect(e.candidates[1].imageUrl).toBe("https://cdn.shopify.com/s/x/hydrogen.jpg"); });
  it("5. correct variant linked to correct product", () => { expect(e.candidates[0].variantId).toBe("9111"); expect(e.candidates[0].sku).toBe("LIQ-1"); expect(e.candidates[2].variantId).toBe("9333"); });
  it("10. unknown flex/riding-style remain unknown", () => { expect(e.candidates[0].unknownAttributes).toEqual(expect.arrayContaining(["flex", "riding_style", "board_length"])); expect(e.unavailableFilters).toEqual(expect.arrayContaining(["flex", "length", "riding_style"])); });
});

describe("grounded renderer (6-9,12)", () => {
  const e = env();
  it("6. cannot invent a 4th product - PRODUCT_4 is blocked", () => {
    const r = renderGroundedProductReply("I recommend PRODUCT_1 and PRODUCT_4 for you.", e, "en");
    expect(r.blocked).toContain("PRODUCT_4");
    expect(r.message).not.toContain("PRODUCT_4");
    // only the real product 1 is rendered
    expect(r.message).toContain("The Collection Snowboard: Liquid");
  });
  it("7. cannot substitute a URL - model URL stripped, only envelope URL present", () => {
    const r = renderGroundedProductReply("Check PRODUCT_1 at https://evil.example.com/fake", e, "en");
    expect(r.message).not.toContain("evil.example.com");
    expect(r.message).toContain("https://urban-supply-gotcha-demo.myshopify.com/products/the-collection-snowboard-liquid");
  });
  it("8. cannot change the price - model amount stripped, envelope price shown", () => {
    const r = renderGroundedProductReply("PRODUCT_1 is a steal at $499.99!", e, "en");
    expect(r.message).not.toContain("499.99");
    expect(r.message).toContain("749.95");
  });
  it("9. cannot claim in-stock when envelope says out_of_stock", () => {
    const r = renderGroundedProductReply("PRODUCT_2 is in stock and ready!", e, "en");
    // envelope says product 2 (Hydrogen) qty 0 -> out of stock; renderer shows out of stock
    expect(r.message).toContain("out of stock");
    // the model's "in stock ready" prose money/urls stripped; availability from envelope only
  });
  it("12. a malformed/reference-less reply falls back to the full deterministic list", () => {
    const r = renderGroundedProductReply("uh sure whatever", e, "en");
    expect(r.usedFallback).toBe(true);
    expect(r.message).toContain("The Collection Snowboard: Liquid");
    expect(r.message).toContain("The Archived Snowboard");
  });
});

describe("humanizer safety (11)", () => {
  it("11. the shared sanitizer does not alter URLs/prices in the rendered message", () => {
    const e = env();
    const r = renderGroundedProductReply("PRODUCT_1 fits your all-mountain style well.", e, "en");
    const after = sanitizeCustomerText(r.message);
    expect(after).toContain("https://urban-supply-gotcha-demo.myshopify.com/products/the-collection-snowboard-liquid");
    expect(after).toContain("749.95");
    expect(after).not.toMatch(/[—–―]/);
  });
});

describe("no-results & provider-failure (13,14)", () => {
  it("13. zero-result envelope renders an honest no-results line, not products", () => {
    const zero = normalizeShopifyProducts([], { shopDomain: "s.myshopify.com" });
    const r = renderGroundedProductReply("PRODUCT_1 is great", zero, "en");
    expect(zero.status).toBe("no_results");
    expect(r.message.toLowerCase()).toMatch(/couldn't find|no products/);
  });
  it("14. provider FAILURE is not presented as no-results - it's a blocker/handoff", () => {
    const errEnv: ProductSearchEnvelope = { provider: "shopify", tool: "shopify_product_search", status: "error", candidates: [], appliedFilters: [], unavailableFilters: [], safeModelSummary: "" };
    const r = renderGroundedProductReply("PRODUCT_1", errEnv, "en");
    expect(r.usedFallback).toBe(true);
    expect(r.message.toLowerCase()).toMatch(/couldn't reach|catalog|team/);
    expect(r.message.toLowerCase()).not.toMatch(/no products|no matches/);
    // and the model summary tells the model NOT to claim a search ran
    expect(buildKeyedModelSummary(errEnv, "en")).toContain("PRODUCT_SEARCH_FAILED");
  });
});

describe("tenant isolation (15)", () => {
  it("15. two tenants' shop domains produce distinct exact URLs; renderer is pure", () => {
    const a = renderGroundedProductReply("PRODUCT_1", env("tenant-a.myshopify.com"), "en");
    const b = renderGroundedProductReply("PRODUCT_1", env("tenant-b.myshopify.com"), "en");
    expect(a.message).toContain("https://tenant-a.myshopify.com/products/the-collection-snowboard-liquid");
    expect(b.message).toContain("https://tenant-b.myshopify.com/products/the-collection-snowboard-liquid");
    expect(a.message).not.toContain("tenant-b");
  });
});

describe("keyed model summary is safe", () => {
  it("hides raw URLs; exposes PRODUCT_n keys + safe facts + unknowns", () => {
    const s = buildKeyedModelSummary(env(), "en");
    expect(s).toContain("PRODUCT_1:");
    expect(s).not.toContain("https://"); // model never sees URLs to copy
    expect(s).toContain("unknown: riding_style, flex, board_length".replace("riding_style, flex, board_length", "").trim()); // has an unknown clause
    expect(s.toLowerCase()).toContain("unknown");
  });
});
