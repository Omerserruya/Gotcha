import { describe, it, expect } from "vitest";
import {
  normalizeShopifyProducts,
  renderCandidatesForWhatsApp,
  type ProductSearchEnvelope,
} from "../services/product-search.service";

const SHOP = "shop.myshopify.com";

function rawSnowboard(overrides: Record<string, any> = {}) {
  return {
    id: 7890123456,
    title: "The Collection Snowboard: Hydrogen",
    handle: "the-collection-snowboard-hydrogen",
    product_type: "snowboard",
    vendor: "Hydrogen Vendor",
    variants: [
      {
        id: 42001,
        sku: "HYD-155",
        price: "600.00",
        inventory_quantity: 12,
        inventory_management: "shopify",
      },
    ],
    image: { src: "https://cdn.shopify.com/hydrogen.png" },
    images: [{ src: "https://cdn.shopify.com/hydrogen.png" }],
    ...overrides,
  };
}

describe("normalizeShopifyProducts", () => {
  it("builds a byte-exact product URL from the handle", () => {
    const env = normalizeShopifyProducts([rawSnowboard()], { shopDomain: SHOP });
    expect(env.candidates[0].url).toBe(
      "https://shop.myshopify.com/products/the-collection-snowboard-hydrogen",
    );
  });

  it("preserves price, currency and variantId as exact atoms", () => {
    const env = normalizeShopifyProducts([rawSnowboard()], {
      shopDomain: SHOP,
      budget: { target: 600, currency: "USD" },
    });
    const c = env.candidates[0];
    expect(c.price).toBe("600.00");
    expect(c.currency).toBe("USD");
    expect(c.variantId).toBe("42001");
    expect(c.productId).toBe("7890123456");
    expect(c.sku).toBe("HYD-155");
    expect(c.imageUrl).toBe("https://cdn.shopify.com/hydrogen.png");
    expect(c.attributes.product_type).toBe("snowboard");
    expect(c.attributes.vendor).toBe("Hydrogen Vendor");
  });

  it("derives inventoryState in_stock from a positive quantity", () => {
    const env = normalizeShopifyProducts([rawSnowboard()], { shopDomain: SHOP });
    expect(env.candidates[0].inventoryState).toBe("in_stock");
  });

  it("derives inventoryState out_of_stock from zero quantity", () => {
    const raw = rawSnowboard({
      variants: [
        { id: 1, price: "10.00", inventory_quantity: 0, inventory_management: "shopify" },
      ],
    });
    const env = normalizeShopifyProducts([raw], { shopDomain: SHOP });
    expect(env.candidates[0].inventoryState).toBe("out_of_stock");
  });

  it("treats untracked inventory (inventory_management null) as in_stock", () => {
    const raw = rawSnowboard({
      variants: [
        { id: 1, price: "10.00", inventory_quantity: 0, inventory_management: null },
      ],
    });
    const env = normalizeShopifyProducts([raw], { shopDomain: SHOP });
    expect(env.candidates[0].inventoryState).toBe("in_stock");
  });

  it("marks discovery attrs as unknown and never invents them", () => {
    const env = normalizeShopifyProducts([rawSnowboard()], { shopDomain: SHOP });
    const c = env.candidates[0];
    expect(c.unknownAttributes).toEqual(["riding_style", "flex", "board_length"]);
    // never invented into structured attributes
    expect(c.attributes).not.toHaveProperty("riding_style");
    expect(c.attributes).not.toHaveProperty("flex");
    expect(c.attributes).not.toHaveProperty("board_length");
  });

  it("reports requested discovery filters as unavailable", () => {
    const env = normalizeShopifyProducts([rawSnowboard()], {
      shopDomain: SHOP,
      requestedFilters: ["query", "riding_style", "flex", "length"],
    });
    expect(env.unavailableFilters).toEqual(["riding_style", "flex", "length"]);
    expect(env.appliedFilters).toContain("query");
  });

  it("matchQuality is exact within budget and approximate over budget", () => {
    const within = normalizeShopifyProducts([rawSnowboard()], {
      shopDomain: SHOP,
      budget: { target: 600, currency: "USD" },
    });
    expect(within.candidates[0].matchQuality).toBe("exact");

    const over = normalizeShopifyProducts(
      [rawSnowboard({ variants: [{ id: 1, price: "900.00", inventory_quantity: 1, inventory_management: "shopify" }] })],
      { shopDomain: SHOP, budget: { target: 600, currency: "USD" } },
    );
    expect(over.candidates[0].matchQuality).toBe("approximate");
  });

  it("matchQuality defaults to exact when no budget is given", () => {
    const env = normalizeShopifyProducts([rawSnowboard()], { shopDomain: SHOP });
    expect(env.candidates[0].matchQuality).toBe("exact");
    expect(env.appliedFilters).not.toContain("budget");
  });

  it("returns no_results status and honest summary for empty input", () => {
    const env = normalizeShopifyProducts([], { shopDomain: SHOP });
    expect(env.status).toBe("no_results");
    expect(env.candidates).toHaveLength(0);
    expect(env.safeModelSummary).toBe("No matching products found.");
  });
});

describe("renderCandidatesForWhatsApp", () => {
  it("renders an honest no-results line", () => {
    const env = normalizeShopifyProducts([], { shopDomain: SHOP });
    const en = renderCandidatesForWhatsApp(env, "en");
    const he = renderCandidatesForWhatsApp(env, "he");
    expect(en).toBe("I couldn't find any products matching that search.");
    expect(he.length).toBeGreaterThan(0);
  });

  it("keeps exact URL and price, and contains no em dash", () => {
    const env: ProductSearchEnvelope = normalizeShopifyProducts([rawSnowboard()], {
      shopDomain: SHOP,
      budget: { target: 600, currency: "USD" },
    });
    const out = renderCandidatesForWhatsApp(env, "en");
    expect(out).toContain(
      "https://shop.myshopify.com/products/the-collection-snowboard-hydrogen",
    );
    expect(out).toContain("600.00");
    expect(out).not.toContain("—"); // em dash
    expect(out).not.toContain("–"); // en dash
    expect(out).not.toContain("riding_style");
  });
});
