/**
 * The delivery layer: search results in, a channel decision out.
 *
 * The invariant under test is the separation itself. A Shopify tool
 * produces a set; this decides the presentation; an adapter sends it. If
 * any Shopify-specific shape leaks past the converter, or any price is
 * recomputed on the way through, that is the bug this file catches.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recommendationSetFromSearchEnvelope,
  planRecommendationDelivery,
  markRecommendationDelivered,
  wasRecommendationDelivered,
  __resetRecommendationDedup,
} from "../services/recommendation-delivery.service";
import { normalizeShopifyProducts } from "../services/product-search.service";

const SHOP = "demo-store.myshopify.com";

function rawProduct(overrides: Record<string, any> = {}) {
  return {
    id: 111,
    title: "Cloud Pro Runner",
    handle: "cloud-pro",
    status: "active",
    vendor: "Cloud",
    image: { src: "https://cdn.shopify.com/s/files/1/x.jpg" },
    variants: [
      { id: 9001, sku: "AIR-90", price: "749.95", available: true, inventory_quantity: 4 },
    ],
    ...overrides,
  };
}

function envelope(products = [rawProduct()], shopCurrency = "USD") {
  return normalizeShopifyProducts(products, { shopDomain: SHOP, shopCurrency });
}

beforeEach(() => __resetRecommendationDedup());

describe("search envelope to recommendation set", () => {
  it("carries the exact URL, price and currency the envelope resolved", () => {
    const set = recommendationSetFromSearchEnvelope(envelope(), { shopDomain: SHOP });
    expect(set.products[0]).toMatchObject({
      productId: "111",
      variantId: "9001",
      title: "Cloud Pro Runner",
      productUrl: `https://${SHOP}/products/cloud-pro`,
      price: { amount: "749.95", currency: "USD" },
      availability: "in_stock",
      sku: "AIR-90",
    });
  });

  it("never rounds or reformats the amount", () => {
    const set = recommendationSetFromSearchEnvelope(
      envelope([rawProduct({ variants: [{ id: 9001, price: "1249.9", available: true }] })]),
      { shopDomain: SHOP },
    );
    expect(set.products[0].price).toEqual({ amount: "1249.9", currency: "USD" });
  });

  it("drops the price entirely when the STORE's currency is unknown", () => {
    // The envelope leaves `currency` undefined when Shopify's shop
    // currency could not be read. An unlabelled number beside a product
    // reads as a price in whatever currency the shopper assumes, which is
    // how a $749 board was once shown to an Israeli shopper as ILS 749.
    const noCurrency = normalizeShopifyProducts([rawProduct()], { shopDomain: SHOP });
    const set = recommendationSetFromSearchEnvelope(noCurrency, { shopDomain: SHOP });
    expect(set.products[0].price).toBeUndefined();
  });

  it("marks an out-of-stock product and never as purchasable", () => {
    const set = recommendationSetFromSearchEnvelope(
      envelope([
        rawProduct({
          title: "The Out of Stock Snowboard",
          variants: [{ id: 9001, price: "100.00", available: false, inventory_quantity: 0 }],
        }),
      ]),
      { shopDomain: SHOP },
    );
    expect(set.products[0].availability).toBe("out_of_stock");
    expect(set.products[0].purchasable).toBe(false);
  });

  it("never marks a SEARCH result purchasable, even in stock", () => {
    // A search result names a variant; it has not validated that the
    // variant can be bought. Add to Cart requires the storefront cart
    // endpoint to re-resolve it.
    const set = recommendationSetFromSearchEnvelope(envelope(), { shopDomain: SHOP });
    expect(set.products[0].purchasable).toBe(false);
  });

  it("honours an explicit product shortlist and its order", () => {
    const env = envelope([
      rawProduct({ id: 1, handle: "a", title: "A" }),
      rawProduct({ id: 2, handle: "b", title: "B" }),
      rawProduct({ id: 3, handle: "c", title: "C" }),
    ]);
    const set = recommendationSetFromSearchEnvelope(env, {
      shopDomain: SHOP,
      productIds: ["3", "1"],
    });
    expect(set.products.map((p) => p.title)).toEqual(["C", "A"]);
  });

  it("ignores an id the envelope does not contain - no invented product", () => {
    const set = recommendationSetFromSearchEnvelope(envelope(), {
      shopDomain: SHOP,
      productIds: ["111", "999999"],
    });
    expect(set.products).toHaveLength(1);
  });

  it("keeps the model's introduction and nothing else from it", () => {
    const set = recommendationSetFromSearchEnvelope(envelope(), {
      shopDomain: SHOP,
      introduction: "מצאתי שלוש אפשרויות:",
    });
    expect(set.introduction).toBe("מצאתי שלוש אפשרויות:");
  });

  it("records the provider, so a future integration is not mistaken for Shopify", () => {
    expect(recommendationSetFromSearchEnvelope(envelope()).source.integration).toBe("shopify");
  });
});

describe("delivery plan", () => {
  const set = () => recommendationSetFromSearchEnvelope(
    envelope([
      rawProduct({ id: 1, handle: "a", title: "A" }),
      rawProduct({ id: 2, handle: "b", title: "B" }),
    ]),
    { shopDomain: SHOP, introduction: "הנה שתי אפשרויות:" },
  );

  it("gives the storefront a carousel", () => {
    expect(planRecommendationDelivery({ channel: "SHOPIFY_LIVE_CHAT", recommendationSet: set() }).presentation)
      .toBe("native_carousel");
  });

  it("gives WhatsApp image cards, not a carousel it cannot render", () => {
    expect(planRecommendationDelivery({ channel: "WHATSAPP", recommendationSet: set() }).presentation)
      .toBe("image_cards");
  });

  it("gives email rich HTML", () => {
    expect(planRecommendationDelivery({ channel: "EMAIL", recommendationSet: set() }).presentation)
      .toBe("rich_html");
  });

  it("gives an unknown channel clean text", () => {
    expect(planRecommendationDelivery({ channel: "TELEGRAM", recommendationSet: set() }).presentation)
      .toBe("text");
  });

  it("always carries a text fallback with the exact links", () => {
    for (const channel of ["SHOPIFY_LIVE_CHAT", "WHATSAPP", "EMAIL", "VOICE", "SMS"]) {
      const plan = planRecommendationDelivery({ channel, recommendationSet: set() });
      expect(plan.textFallback, channel).toContain(`https://${SHOP}/products/a`);
    }
  });
});

describe("retry suppression", () => {
  const KEY = "rec_abc123";

  it("a set that has not been sent is not suppressed", () => {
    expect(wasRecommendationDelivered("conv1", KEY)).toBe(false);
  });

  it("the same set to the same conversation is suppressed", () => {
    markRecommendationDelivered("conv1", KEY);
    expect(wasRecommendationDelivered("conv1", KEY)).toBe(true);
  });

  it("is scoped per conversation - tenant isolation is not optional here", () => {
    markRecommendationDelivered("conv1", KEY);
    expect(wasRecommendationDelivered("conv2", KEY)).toBe(false);
  });

  it("a different set to the same conversation is not suppressed", () => {
    markRecommendationDelivered("conv1", KEY);
    expect(wasRecommendationDelivered("conv1", "rec_different")).toBe(false);
  });

  it("expires, so a genuine re-recommendation later still goes out", () => {
    const t0 = 1_000_000;
    markRecommendationDelivered("conv1", KEY, t0);
    expect(wasRecommendationDelivered("conv1", KEY, t0 + 60_000)).toBe(true);
    expect(wasRecommendationDelivered("conv1", KEY, t0 + 6 * 60_000)).toBe(false);
  });

  it("does not grow without bound", () => {
    for (let i = 0; i < 1500; i++) markRecommendationDelivered(`conv${i}`, KEY);
    // The newest entry survives; the map has been swept.
    expect(wasRecommendationDelivered("conv1499", KEY)).toBe(true);
  });
});
