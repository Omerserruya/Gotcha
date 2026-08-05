/**
 * The automatic path and the manual picker must be the same thing.
 *
 * They were not: the picker produced a validated `shopify_product_carousel`
 * while the AI produced a paragraph of URLs. Fixing that is only durable
 * if both ends stay converged, which is what this file checks - same
 * record shape, same canonical schema, same store-scoping refusals.
 */
import { describe, it, expect } from "vitest";
import {
  buildProductMessageRecord,
  type ProductMessageRecord,
} from "../services/shopify-commerce-message.service";
import {
  recommendationSetFromShopifySnapshots,
  providerRecordsFromShopifySnapshots,
  reconcileWithProvider,
  isRenderableCommercePayload,
  renderProductRecommendations,
  capabilitiesFor,
  SHOPIFY_MESSAGE_TYPES,
  type ProductSnapshot,
  type ShopifyCommerceMessagePayload,
} from "@chatcenter/shared";

const SHOP = "demo-store.myshopify.com";
const OTHER_SHOP = "rival-store.myshopify.com";
const CHANNEL = "ca_1";

function snapshot(id: string, overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    shopDomain: SHOP,
    productId: id,
    handle: `p-${id}`,
    title: `Product ${id}`,
    imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg",
    productUrl: `https://${SHOP}/products/p-${id}`,
    currency: "USD",
    price: "600.00",
    compareAtPrice: null,
    available: true,
    status: "active",
    vendor: null,
    selectedVariantId: "9001",
    optionNames: [],
    variants: [
      {
        variantId: "9001",
        title: "Default",
        price: "600.00",
        compareAtPrice: null,
        available: true,
        sku: "SKU-1",
        options: [],
        requiresSellingPlan: false,
      },
    ],
    reason: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** What the AUTOMATIC path stages (via stageProducts → buildProductMessageRecord). */
function automaticRecord(products: ProductSnapshot[]): ProductMessageRecord | null {
  return buildProductMessageRecord({
    shopDomain: SHOP,
    channelAccountId: CHANNEL,
    products,
    addToCartEnabled: true,
    source: "ai",
  });
}

/** What the MANUAL picker writes. Same builder, different source. */
function manualRecord(products: ProductSnapshot[]): ProductMessageRecord | null {
  return buildProductMessageRecord({
    shopDomain: SHOP,
    channelAccountId: CHANNEL,
    products,
    addToCartEnabled: true,
    source: "agent",
  });
}

// ─── 3 + 4. Both paths, one schema ───────────────────────────

describe("3/4. the automatic path and the picker produce the same shape", () => {
  const products = [snapshot("1"), snapshot("2"), snapshot("3")];

  it("both emit shopify_product_carousel for a shortlist", () => {
    expect(automaticRecord(products)!.messageType).toBe(SHOPIFY_MESSAGE_TYPES.PRODUCT_CAROUSEL);
    expect(manualRecord(products)!.messageType).toBe(SHOPIFY_MESSAGE_TYPES.PRODUCT_CAROUSEL);
  });

  it("both emit shopify_product for a single product", () => {
    expect(automaticRecord([snapshot("1")])!.messageType).toBe(SHOPIFY_MESSAGE_TYPES.PRODUCT);
    expect(manualRecord([snapshot("1")])!.messageType).toBe(SHOPIFY_MESSAGE_TYPES.PRODUCT);
  });

  it("the payloads differ ONLY by who sent them", () => {
    const auto = automaticRecord(products)!.metadata.shopify as ShopifyCommerceMessagePayload;
    const manual = manualRecord(products)!.metadata.shopify as ShopifyCommerceMessagePayload;
    expect(auto.source).toBe("ai");
    expect(manual.source).toBe("agent");
    expect({ ...auto, source: null }).toEqual({ ...manual, source: null });
  });

  it("the manual path still works end to end", () => {
    const record = manualRecord(products)!;
    expect(record.body).toContain("3 product suggestions");
    const payload = record.metadata.shopify as ShopifyCommerceMessagePayload;
    expect(payload.products).toHaveLength(3);
    expect(payload.kind).toBe("shopify_commerce");
  });

  it("both convert into the SAME canonical recommendation set", () => {
    const fromAuto = recommendationSetFromShopifySnapshots({
      products: (automaticRecord(products)!.metadata.shopify as ShopifyCommerceMessagePayload).products,
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    const fromManual = recommendationSetFromShopifySnapshots({
      products: (manualRecord(products)!.metadata.shopify as ShopifyCommerceMessagePayload).products,
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    expect(fromAuto).toEqual(fromManual);
    expect(fromAuto.idempotencyKey).toBe(fromManual.idempotencyKey);
  });

  it("the canonical set renders as a carousel on Shopify Live Chat", () => {
    const set = recommendationSetFromShopifySnapshots({
      products,
      shopDomain: SHOP,
      addToCartEnabled: true,
      introduction: "מצאתי שלוש אפשרויות:",
    });
    const rendered = renderProductRecommendations({
      channelCapabilities: capabilitiesFor("SHOPIFY_LIVE_CHAT"),
      recommendationSet: set,
      locale: "he",
    });
    expect(rendered.presentation).toBe("native_carousel");
    expect(rendered.included).toHaveLength(3);
    // One short intro, and the products live in the carousel, not the text.
    const textParts = rendered.messages.filter((m) => m.kind === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as any).text).toBe("מצאתי שלוש אפשרויות:");
    expect((textParts[0] as any).text).not.toContain("https://");
  });

  it("survives the provider checkpoint unchanged", () => {
    const set = recommendationSetFromShopifySnapshots({
      products,
      shopDomain: SHOP,
      addToCartEnabled: true,
    });
    const r = reconcileWithProvider(set, providerRecordsFromShopifySnapshots(products));
    expect(r.removed).toHaveLength(0);
    expect(r.corrections).toHaveLength(0);
  });
});

// ─── 8. Tenant and shop isolation ────────────────────────────

describe("8. tenant and shop isolation", () => {
  it("the record builder refuses a product from another store", () => {
    expect(automaticRecord([snapshot("1"), snapshot("2", { shopDomain: OTHER_SHOP })])).toBeNull();
    expect(manualRecord([snapshot("1"), snapshot("2", { shopDomain: OTHER_SHOP })])).toBeNull();
  });

  it("the canonical converter drops a product from another store", () => {
    const set = recommendationSetFromShopifySnapshots({
      products: [snapshot("1"), snapshot("2", { shopDomain: OTHER_SHOP })],
      shopDomain: SHOP,
    });
    expect(set.products).toHaveLength(1);
    expect(set.products[0].productId).toBe("1");
  });

  it("a payload is not renderable in another store's conversation", () => {
    const payload = automaticRecord([snapshot("1")])!.metadata.shopify;
    expect(isRenderableCommercePayload(payload, { shopDomain: SHOP, channelAccountId: CHANNEL })).toBe(true);
    expect(isRenderableCommercePayload(payload, { shopDomain: OTHER_SHOP, channelAccountId: CHANNEL })).toBe(false);
  });

  it("a payload is not renderable on another CHANNEL of the same store", () => {
    // Same shop, different channel account: still refused. This is the
    // guard that survives a mis-joined query.
    const payload = automaticRecord([snapshot("1")])!.metadata.shopify;
    expect(isRenderableCommercePayload(payload, { shopDomain: SHOP, channelAccountId: "ca_other" })).toBe(false);
  });

  it("the provider checkpoint removes a product the store does not have", () => {
    const set = recommendationSetFromShopifySnapshots({
      products: [snapshot("1"), snapshot("2")],
      shopDomain: SHOP,
    });
    // The provider only confirms one of them.
    const r = reconcileWithProvider(set, providerRecordsFromShopifySnapshots([snapshot("1")]));
    expect(r.set.products).toHaveLength(1);
    expect(r.removed.map((p) => p.productId)).toEqual(["2"]);
  });
});
