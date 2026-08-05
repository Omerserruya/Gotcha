/**
 * Where a recommendation becomes a delivery plan.
 *
 * The separation this file protects:
 *
 *   Shopify adapter/tool  →  ProductRecommendationSet   (provider truth)
 *   this file             →  RenderedRecommendations    (channel decision)
 *   outbound adapters     →  provider payload
 *
 * No Shopify tool learns what a WhatsApp interactive message is, and no
 * channel adapter learns what a Shopify variant is. A second commerce
 * integration adds one converter here and changes nothing downstream.
 */

import {
  capabilitiesFor,
  normalizeRecommendationSet,
  renderProductRecommendations,
  recommendationIdempotencyKey,
  type ProductRecommendationSet,
  type RecommendationLocale,
  type RenderedRecommendations,
} from "@chatcenter/shared";
import type { ProductSearchEnvelope } from "./product-search.service";

/**
 * The typed search envelope, as a channel-neutral recommendation set.
 *
 * `ProductSearchEnvelope` is already the "never flattened into model text"
 * shape - exact ids, exact URLs, exact prices, the store's own currency.
 * This is a re-labelling, not a re-derivation: nothing is recomputed,
 * because every recomputation is another chance to quote a wrong number.
 */
export function recommendationSetFromSearchEnvelope(
  envelope: ProductSearchEnvelope,
  opts: {
    shopDomain?: string;
    /** The model's lead-in. The one part of a set it may write. */
    introduction?: string | null;
    /** Only these candidates, in this order. Absent → all of them. */
    productIds?: string[];
  } = {},
): ProductRecommendationSet {
  const candidates =
    opts.productIds && opts.productIds.length
      ? opts.productIds
          .map((id) => envelope.candidates.find((c) => c.productId === id))
          .filter((c): c is (typeof envelope.candidates)[number] => !!c)
      : envelope.candidates;

  return normalizeRecommendationSet({
    introduction: opts.introduction ?? undefined,
    products: candidates.map((c) => ({
      productId: c.productId,
      variantId: c.variantId,
      title: c.title,
      productUrl: c.url,
      imageUrl: c.imageUrl,
      // A price with no currency is dropped by the normalizer rather than
      // shown bare. That is deliberate: the envelope leaves `currency`
      // undefined when the STORE's currency could not be read, and an
      // unlabelled number next to a product reads as a price in whatever
      // currency the shopper assumes.
      price: c.price && c.currency ? { amount: c.price, currency: c.currency } : undefined,
      availability:
        c.inventoryState === "in_stock"
          ? "in_stock"
          : c.inventoryState === "out_of_stock"
            ? "out_of_stock"
            : "unknown",
      sku: c.sku,
      // Search results name a variant but have not validated it as
      // purchasable. Add to Cart requires a re-resolve, which is the
      // storefront cart endpoint's job, not a search result's.
      purchasable: false,
    })),
    source: { integration: envelope.provider, shopDomain: opts.shopDomain },
  });
}

export interface DeliveryPlanInput {
  channel: string | null | undefined;
  recommendationSet: ProductRecommendationSet;
  locale?: RecommendationLocale | string;
}

/**
 * Decide how this set reaches this customer on this channel.
 *
 * Pure. Sends nothing. The caller does the sending and is responsible for
 * honouring `idempotencyKey` and for falling back to `textFallback` when a
 * provider rejects the rich payload.
 */
export function planRecommendationDelivery(input: DeliveryPlanInput): RenderedRecommendations {
  return renderProductRecommendations({
    channelCapabilities: capabilitiesFor(input.channel),
    recommendationSet: input.recommendationSet,
    locale: input.locale,
  });
}

/**
 * Retry suppression.
 *
 * A recommendation that has already reached a customer must not reach them
 * again because an outbound send was retried. The key is content-derived,
 * so the retry of a timed-out send carries the same one and is recognised.
 *
 * Deliberately in-process and bounded rather than backed by Redis: this
 * guards the retry of a single delivery attempt, which lives and dies
 * inside one worker run. A cross-process guarantee belongs on the message
 * row, and the message row already has one - a set that was persisted was
 * delivered.
 */
const RECENT_DELIVERIES = new Map<string, number>();
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 1000;

export function markRecommendationDelivered(conversationId: string, idempotencyKey: string, now = Date.now()): void {
  prune(now);
  RECENT_DELIVERIES.set(`${conversationId}:${idempotencyKey}`, now);
}

export function wasRecommendationDelivered(
  conversationId: string,
  idempotencyKey: string,
  now = Date.now(),
): boolean {
  prune(now);
  const at = RECENT_DELIVERIES.get(`${conversationId}:${idempotencyKey}`);
  return at != null && now - at < DEDUP_WINDOW_MS;
}

/** Test seam. The map is module state; a suite that shares it is flaky. */
export function __resetRecommendationDedup(): void {
  RECENT_DELIVERIES.clear();
}

function prune(now: number): void {
  if (RECENT_DELIVERIES.size < DEDUP_MAX_ENTRIES) {
    // Cheap path: only sweep when the map is actually growing.
    for (const [key, at] of RECENT_DELIVERIES) {
      if (now - at >= DEDUP_WINDOW_MS) RECENT_DELIVERIES.delete(key);
    }
    return;
  }
  // Over the cap: drop the oldest half rather than unbounded growth. Map
  // iterates in insertion order, so this is the oldest half by send time.
  const drop = Math.floor(RECENT_DELIVERIES.size / 2);
  let i = 0;
  for (const key of RECENT_DELIVERIES.keys()) {
    if (i++ >= drop) break;
    RECENT_DELIVERIES.delete(key);
  }
}

export { recommendationIdempotencyKey };
