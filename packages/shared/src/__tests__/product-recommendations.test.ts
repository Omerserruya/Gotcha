/**
 * The canonical recommendation set.
 *
 * Most of this file is about what must NOT survive: a model-written URL,
 * a price with no currency, a product the provider does not have, the
 * same shirt twice, an Add to Cart on something nobody can buy. A
 * recommendation that shows the wrong price is not a display bug, it is a
 * quote.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeRecommendationSet,
  reconcileWithProvider,
  recommendationIdempotencyKey,
  availabilityLabel,
  priceLabel,
  type ProductRecommendationSet,
  type ProviderProductRecord,
} from "../lib/product-recommendations";
import {
  recommendationSetFromShopifySnapshots,
  providerRecordsFromShopifySnapshots,
  type ProductSnapshot,
} from "../lib/shopify-live-chat";

const SHOP = "demo-store.myshopify.com";

function product(overrides: Record<string, any> = {}) {
  return {
    productId: "111",
    title: "Cloud Pro Runner",
    productUrl: `https://${SHOP}/products/cloud-pro`,
    imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg",
    price: { amount: "120.00", currency: "USD" },
    availability: "in_stock",
    ...overrides,
  };
}

function set(products: any[], extra: Record<string, any> = {}): ProductRecommendationSet {
  return normalizeRecommendationSet({
    products,
    source: { integration: "shopify", shopDomain: SHOP },
    ...extra,
  });
}

// ─── Normalization ───────────────────────────────────────────

describe("normalizeRecommendationSet", () => {
  it("keeps a well-formed product intact", () => {
    const s = set([product()]);
    expect(s.products).toHaveLength(1);
    expect(s.products[0]).toMatchObject({
      productId: "111",
      title: "Cloud Pro Runner",
      productUrl: `https://${SHOP}/products/cloud-pro`,
      price: { amount: "120.00", currency: "USD" },
      availability: "in_stock",
    });
  });

  it("drops a product with no URL - there is nothing to recommend", () => {
    expect(set([product({ productUrl: undefined })]).products).toHaveLength(0);
  });

  it("drops a non-https URL", () => {
    expect(set([product({ productUrl: `http://${SHOP}/products/x` })]).products).toHaveLength(0);
    expect(set([product({ productUrl: "javascript:alert(1)" })]).products).toHaveLength(0);
  });

  it("drops a product with no id or no title", () => {
    expect(set([product({ productId: "" })]).products).toHaveLength(0);
    expect(set([product({ title: "   " })]).products).toHaveLength(0);
  });

  it("drops a price with no currency, rather than showing a bare number", () => {
    const s = set([product({ price: { amount: "120.00" } })]);
    expect(s.products[0].price).toBeUndefined();
  });

  it("drops a price that is not a number", () => {
    expect(set([product({ price: { amount: "about 120", currency: "USD" } })])[
      "products"
    ][0].price).toBeUndefined();
  });

  it("never re-formats an amount the provider gave", () => {
    const s = set([product({ price: { amount: "1249.9", currency: "ILS" } })]);
    expect(s.products[0].price).toEqual({ amount: "1249.9", currency: "ILS" });
  });

  it("collapses duplicates on (productId, variantId)", () => {
    const s = set([product(), product(), product({ variantId: "9001" })]);
    expect(s.products).toHaveLength(2);
  });

  it("strips bidi overrides from a title", () => {
    const s = set([product({ title: "Cloud‮Pro" })]);
    expect(s.products[0].title).toBe("Cloud Pro");
  });

  it("collapses an unknown availability value to unknown", () => {
    expect(set([product({ availability: "maybe" })]).products[0].availability).toBe("unknown");
  });

  it("refuses Add to Cart without a variant", () => {
    const s = set([product({ purchasable: true })]);
    expect(s.products[0].purchasable).toBe(false);
  });

  it("refuses Add to Cart on an out-of-stock product even with a variant", () => {
    const s = set([product({ variantId: "9001", purchasable: true, availability: "out_of_stock" })]);
    expect(s.products[0].purchasable).toBe(false);
  });

  it("allows Add to Cart with a variant, stock and an explicit flag", () => {
    const s = set([product({ variantId: "9001", purchasable: true })]);
    expect(s.products[0].purchasable).toBe(true);
  });

  it("survives complete garbage", () => {
    expect(normalizeRecommendationSet(null).products).toEqual([]);
    expect(normalizeRecommendationSet({ products: "nope" }).products).toEqual([]);
    expect(normalizeRecommendationSet(42).source.integration).toBe("unknown");
  });
});

// ─── Idempotency ─────────────────────────────────────────────

describe("idempotency key", () => {
  it("is stable for the same products", () => {
    expect(recommendationIdempotencyKey(set([product()]))).toBe(
      recommendationIdempotencyKey(set([product()])),
    );
  });

  it("ignores the introduction - rewording is not a new recommendation", () => {
    const a = set([product()], { introduction: "Here are three options" });
    const b = set([product()], { introduction: "מצאתי שלוש אפשרויות" });
    expect(recommendationIdempotencyKey(a)).toBe(recommendationIdempotencyKey(b));
  });

  it("changes when the products change", () => {
    const a = set([product()]);
    const b = set([product({ productId: "222" })]);
    expect(recommendationIdempotencyKey(a)).not.toBe(recommendationIdempotencyKey(b));
  });

  it("changes when a price changes", () => {
    const a = set([product()]);
    const b = set([product({ price: { amount: "99.00", currency: "USD" } })]);
    expect(recommendationIdempotencyKey(a)).not.toBe(recommendationIdempotencyKey(b));
  });

  it("changes when the variant changes", () => {
    const a = set([product({ variantId: "9001" })]);
    const b = set([product({ variantId: "9002" })]);
    expect(recommendationIdempotencyKey(a)).not.toBe(recommendationIdempotencyKey(b));
  });

  it("is stamped on every normalized set", () => {
    expect(set([product()]).idempotencyKey).toMatch(/^rec_[0-9a-f]{16}$/);
  });
});

// ─── The provider checkpoint ─────────────────────────────────

describe("reconcileWithProvider", () => {
  const providerRecord: ProviderProductRecord = {
    productId: "111",
    variantId: "9001",
    productUrl: `https://${SHOP}/products/cloud-pro?variant=9001`,
    title: "Cloud Pro Runner",
    price: { amount: "120.00", currency: "USD" },
    availability: "in_stock",
    imageUrl: "https://cdn.shopify.com/s/files/1/real.jpg",
    purchasable: true,
  };

  it("removes a product the provider does not have", () => {
    const r = reconcileWithProvider(set([product({ productId: "999" })]), [providerRecord]);
    expect(r.set.products).toHaveLength(0);
    expect(r.removed.map((p) => p.productId)).toEqual(["999"]);
  });

  it("overwrites an invented URL with the provider's", () => {
    const r = reconcileWithProvider(
      set([product({ variantId: "9001", productUrl: "https://evil.example.com/deal" })]),
      [providerRecord],
    );
    expect(r.set.products[0].productUrl).toBe(providerRecord.productUrl);
    expect(r.corrections).toContainEqual({
      productId: "111",
      field: "productUrl",
      was: "https://evil.example.com/deal",
      now: providerRecord.productUrl,
    });
  });

  it("overwrites an invented price with the provider's", () => {
    const r = reconcileWithProvider(
      set([product({ variantId: "9001", price: { amount: "49.00", currency: "USD" } })]),
      [providerRecord],
    );
    expect(r.set.products[0].price).toEqual({ amount: "120.00", currency: "USD" });
    expect(r.corrections.some((c) => c.field === "price")).toBe(true);
  });

  it("overwrites an invented stock state", () => {
    const r = reconcileWithProvider(
      set([product({ variantId: "9001", availability: "in_stock" })]),
      [{ ...providerRecord, availability: "out_of_stock" }],
    );
    expect(r.set.products[0].availability).toBe("out_of_stock");
  });

  it("keeps the reason and the button label - those ARE the caller's", () => {
    const r = reconcileWithProvider(
      set([product({ variantId: "9001", reason: "Lighter cushioning.", buttonLabel: "See it" })]),
      [providerRecord],
    );
    expect(r.set.products[0].reason).toBe("Lighter cushioning.");
    expect(r.set.products[0].buttonLabel).toBe("See it");
  });

  it("strips Add to Cart when the named variant is not the provider's", () => {
    // The product exists, so it is still recommended - but nobody is
    // adding an unverified variant to a cart.
    const r = reconcileWithProvider(
      set([product({ variantId: "8888", purchasable: true })]),
      [providerRecord],
    );
    expect(r.set.products).toHaveLength(1);
    expect(r.set.products[0].purchasable).toBe(false);
  });

  it("recomputes the idempotency key after correcting", () => {
    const original = set([product({ variantId: "9001", price: { amount: "49.00", currency: "USD" } })]);
    const r = reconcileWithProvider(original, [providerRecord]);
    expect(r.set.idempotencyKey).not.toBe(original.idempotencyKey);
  });

  it("an empty provider result empties the set", () => {
    const r = reconcileWithProvider(set([product(), product({ productId: "222" })]), []);
    expect(r.set.products).toHaveLength(0);
    expect(r.removed).toHaveLength(2);
  });
});

// ─── Shopify conversion ──────────────────────────────────────

function snapshot(overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    shopDomain: SHOP,
    productId: "111",
    handle: "cloud-pro",
    title: "Cloud Pro Runner",
    imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg",
    productUrl: `https://${SHOP}/products/cloud-pro?variant=9001`,
    currency: "ILS",
    price: "120.00",
    compareAtPrice: "150.00",
    available: true,
    status: "active",
    vendor: null,
    selectedVariantId: "9001",
    optionNames: [],
    variants: [
      {
        variantId: "9001",
        title: "41",
        price: "120.00",
        compareAtPrice: "150.00",
        available: true,
        sku: "AIR-90",
        options: ["41"],
        requiresSellingPlan: false,
      },
    ],
    reason: "מתאים למה שחיפשת.",
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("recommendationSetFromShopifySnapshots", () => {
  it("carries the store's currency, not the shopper's", () => {
    const s = recommendationSetFromShopifySnapshots({
      products: [snapshot()],
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    expect(s.products[0].price).toEqual({ amount: "120.00", currency: "ILS" });
    expect(s.products[0].compareAtPrice).toEqual({ amount: "150.00", currency: "ILS" });
  });

  it("refuses a snapshot from another store", () => {
    const s = recommendationSetFromShopifySnapshots({
      products: [snapshot({ shopDomain: "other-store.myshopify.com" })],
      shopDomain: SHOP,
    });
    expect(s.products).toHaveLength(0);
  });

  it("offers Add to Cart only with a resolved, available variant", () => {
    const on = recommendationSetFromShopifySnapshots({
      products: [snapshot()],
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    expect(on.products[0].purchasable).toBe(true);

    const noVariant = recommendationSetFromShopifySnapshots({
      products: [snapshot({ selectedVariantId: null })],
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    expect(noVariant.products[0].purchasable).toBe(false);
  });

  it("honours the merchant's Add to Cart switch", () => {
    const off = recommendationSetFromShopifySnapshots({
      products: [snapshot()],
      shopDomain: SHOP,
      addToCartEnabled: false,
    });
    expect(off.products[0].purchasable).toBe(false);
  });

  it("never offers Add to Cart on a subscription-only variant", () => {
    const s = recommendationSetFromShopifySnapshots({
      products: [
        snapshot({
          variants: [
            {
              variantId: "9001",
              title: "41",
              price: "120.00",
              compareAtPrice: null,
              available: true,
              sku: null,
              options: [],
              requiresSellingPlan: true,
            },
          ],
        }),
      ],
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    expect(s.products[0].purchasable).toBe(false);
  });

  it("marks an unavailable product out of stock", () => {
    const s = recommendationSetFromShopifySnapshots({
      products: [
        snapshot({
          available: false,
          variants: [
            {
              variantId: "9001",
              title: "41",
              price: "120.00",
              compareAtPrice: null,
              available: false,
              sku: null,
              options: [],
              requiresSellingPlan: false,
            },
          ],
        }),
      ],
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    expect(s.products[0].availability).toBe("out_of_stock");
    expect(s.products[0].purchasable).toBe(false);
  });

  it("keeps the AI employee's reason", () => {
    const s = recommendationSetFromShopifySnapshots({ products: [snapshot()], shopDomain: SHOP });
    expect(s.products[0].reason).toBe("מתאים למה שחיפשת.");
  });

  it("round-trips through the provider checkpoint unchanged", () => {
    const snaps = [snapshot()];
    const s = recommendationSetFromShopifySnapshots({
      products: snaps,
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    const r = reconcileWithProvider(s, providerRecordsFromShopifySnapshots(snaps));
    expect(r.removed).toHaveLength(0);
    expect(r.corrections).toHaveLength(0);
    expect(r.set.products[0].purchasable).toBe(true);
  });
});

// ─── Labels ──────────────────────────────────────────────────

describe("labels", () => {
  it("says nothing when availability is unknown", () => {
    // A shopper who never asked about stock should not be told it is
    // unknown; that casts doubt on a product that may be fine.
    expect(availabilityLabel("unknown", "en")).toBeNull();
    expect(availabilityLabel(undefined, "he")).toBeNull();
  });

  it("labels the states it knows, in both languages", () => {
    expect(availabilityLabel("in_stock", "en")).toBe("In stock");
    expect(availabilityLabel("out_of_stock", "he")).toBe("אזל מהמלאי");
    expect(availabilityLabel("low_stock", "he")).toBe("כמות מוגבלת");
  });

  it("prints the price exactly as the provider quoted it", () => {
    expect(priceLabel({ amount: "1249.9", currency: "ILS" })).toBe("1249.9 ILS");
    expect(priceLabel(undefined)).toBeNull();
  });
});
