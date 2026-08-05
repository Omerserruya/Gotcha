/**
 * The canonical product recommendation.
 *
 * One shape, produced by a commerce adapter, consumed by a channel
 * renderer. Neither end knows about the other, which is the whole point:
 * the Shopify tools do not learn what a WhatsApp interactive message
 * looks like, and the WhatsApp adapter does not learn what a Shopify
 * variant is.
 *
 *   Shopify adapter/tool
 *     → ProductRecommendationSet   (this file)
 *     → channel presentation adapter (channels/recommendation-renderer)
 *     → provider-specific payload   (channels/*.adapter)
 *
 * ─── The rule that shapes everything below ───────────────────
 *
 * The model may write the introduction. It may not write a product.
 *
 * Every id, URL, price, currency, stock state and variant in a set comes
 * from a provider response and is carried through unmodified. There is no
 * code path where a string the model produced becomes a `productUrl` or a
 * `price`, and `reconcileWithProvider` below is the checkpoint that makes
 * that true even if one were added: a product the provider did not return
 * is dropped, and every field on the ones that survive is overwritten from
 * the provider's own record.
 *
 * A price that is off by a currency is not a display bug. It is a quote.
 */

export type RecommendationAvailability =
  | "in_stock"
  | "low_stock"
  | "out_of_stock"
  | "unknown";

export interface RecommendationMoney {
  /** Exact string from the provider. Never re-formatted, never rounded. */
  amount: string;
  /** ISO 4217, from the STORE, never from the shopper's budget. */
  currency: string;
}

export interface RecommendedProduct {
  productId: string;
  /**
   * Set ONLY when a specific purchasable variant is resolved. Its absence
   * is what stops Add to Cart being offered for a product the shopper
   * still has to pick a size for.
   */
  variantId?: string;
  title: string;
  description?: string;
  imageUrl?: string;
  /** Built by the provider adapter from the handle. Never model-written. */
  productUrl: string;
  price?: RecommendationMoney;
  compareAtPrice?: RecommendationMoney;
  availability?: RecommendationAvailability;
  /** One short line of "why this one", written by the AI employee. */
  reason?: string;
  buttonLabel?: string;
  sku?: string;
  /**
   * Whether this can be added to a cart right now: a resolved variant, in
   * stock, not subscription-only. Distinct from `availability`, which
   * describes the PRODUCT.
   */
  purchasable?: boolean;
}

export interface ProductRecommendationSet {
  /** Short lead-in. The one part of a set the model is allowed to write. */
  introduction?: string;
  products: RecommendedProduct[];
  source: {
    /** "shopify" today. A string, not an enum, so the next commerce
     *  integration needs no change here. */
    integration: "shopify" | string;
    shopDomain?: string;
  };
  /**
   * Stable across retries of the SAME recommendation. Two sends carrying
   * the same key are the same set, and the second must not reach the
   * customer. Derived from the content, not from a clock, so a retry
   * after a provider timeout produces the same key.
   */
  idempotencyKey?: string;
}

// ─── Normalization ───────────────────────────────────────────

const MAX_TITLE = 140;
const MAX_DESCRIPTION = 300;
const MAX_REASON = 200;
const MAX_INTRODUCTION = 400;
const MAX_BUTTON_LABEL = 40;
const MAX_PRODUCTS = 10;

const AVAILABILITY_VALUES: RecommendationAvailability[] = [
  "in_stock",
  "low_stock",
  "out_of_stock",
  "unknown",
];

function text(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw
    // Control characters and bidi overrides. A product title is not a
    // place to hide a direction flip.
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return clean || undefined;
}

/** https only. A product link that is not https is not a product link. */
function url(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function money(raw: unknown): RecommendationMoney | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const amount = typeof src.amount === "string" ? src.amount.trim() : undefined;
  const currency = typeof src.currency === "string" ? src.currency.trim().toUpperCase() : undefined;
  // Both or neither. A bare number with no currency is ambiguous and an
  // ambiguous price shown next to a product reads as a price.
  if (!amount || !currency) return undefined;
  if (!/^\d+(\.\d+)?$/.test(amount)) return undefined;
  if (!/^[A-Z]{3}$/.test(currency)) return undefined;
  return { amount, currency };
}

/**
 * Validate and clean an untrusted set. Anything unusable is dropped
 * rather than repaired: a product with no URL cannot be recommended, and
 * inventing one is exactly what this file exists to prevent.
 *
 * Duplicates collapse on (productId, variantId). The same shirt returned
 * twice by two searches is one recommendation, and a carousel that shows
 * it twice looks like a bug to the shopper because it is one.
 */
export function normalizeRecommendationSet(raw: unknown): ProductRecommendationSet {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const source = (src.source ?? {}) as Record<string, unknown>;

  const seen = new Set<string>();
  const products: RecommendedProduct[] = [];

  for (const entry of Array.isArray(src.products) ? src.products : []) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;

    const productId = p.productId != null ? String(p.productId).trim() : "";
    const productUrl = url(p.productUrl);
    const title = text(p.title, MAX_TITLE);
    if (!productId || !productUrl || !title) continue;

    const variantId = p.variantId != null && String(p.variantId).trim() ? String(p.variantId).trim() : undefined;
    const key = `${productId}::${variantId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const availability = AVAILABILITY_VALUES.includes(p.availability as RecommendationAvailability)
      ? (p.availability as RecommendationAvailability)
      : "unknown";

    products.push({
      productId,
      variantId,
      title,
      description: text(p.description, MAX_DESCRIPTION),
      imageUrl: url(p.imageUrl),
      productUrl,
      price: money(p.price),
      compareAtPrice: money(p.compareAtPrice),
      availability,
      reason: text(p.reason, MAX_REASON),
      buttonLabel: text(p.buttonLabel, MAX_BUTTON_LABEL),
      sku: text(p.sku, 60),
      // Add to Cart needs a variant AND stock. Either missing and the
      // control must not appear at all.
      purchasable: p.purchasable === true && !!variantId && availability !== "out_of_stock",
    });
    if (products.length >= MAX_PRODUCTS) break;
  }

  const set: ProductRecommendationSet = {
    introduction: text(src.introduction, MAX_INTRODUCTION),
    products,
    source: {
      integration:
        typeof source.integration === "string" && source.integration.trim()
          ? source.integration.trim()
          : "unknown",
      shopDomain: typeof source.shopDomain === "string" ? source.shopDomain.trim() || undefined : undefined,
    },
  };
  set.idempotencyKey =
    typeof src.idempotencyKey === "string" && src.idempotencyKey.trim()
      ? src.idempotencyKey.trim()
      : recommendationIdempotencyKey(set);
  return set;
}

/**
 * Content-derived key. Same products, same variants, same order, same
 * source → same key, so a retry after a provider timeout is recognisable
 * as the send it already is.
 *
 * The introduction is deliberately NOT part of it: the model rewording
 * its lead-in does not make these different products, and letting it
 * change the key would let a retry through.
 *
 * A non-cryptographic hash on purpose - this is a dedup token, not a
 * security boundary, and it must work without importing `crypto` so the
 * same function can run in a browser preview.
 */
export function recommendationIdempotencyKey(set: ProductRecommendationSet): string {
  const material = [
    set.source.integration,
    set.source.shopDomain ?? "",
    ...set.products.map((p) => `${p.productId}:${p.variantId ?? ""}:${p.price?.amount ?? ""}${p.price?.currency ?? ""}`),
  ].join("|");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i++) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `rec_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

// ─── The provider checkpoint ─────────────────────────────────

export interface ProviderProductRecord {
  productId: string;
  variantId?: string;
  productUrl: string;
  title: string;
  price?: RecommendationMoney;
  compareAtPrice?: RecommendationMoney;
  availability?: RecommendationAvailability;
  imageUrl?: string;
  sku?: string;
  purchasable?: boolean;
}

export interface ReconcileResult {
  set: ProductRecommendationSet;
  /** Products that were not in the provider result and were removed. */
  removed: RecommendedProduct[];
  /** Fields that disagreed with the provider and were overwritten. */
  corrections: Array<{ productId: string; field: string; was: string; now: string }>;
}

/**
 * Last checkpoint before a set is allowed to reach a customer.
 *
 * Everything identity- or money-shaped is taken from the provider record
 * and overwrites whatever was on the set. Only two fields survive from the
 * caller, because only two are the caller's to write: `reason` and
 * `buttonLabel`. A product with no matching provider record is removed
 * entirely - it may have been delisted, it may belong to another store, or
 * it may never have existed.
 *
 * This runs even when the caller is a Shopify tool that got the data from
 * the same provider a moment ago. It is cheap, and the one time it is not
 * redundant is the time it matters.
 */
export function reconcileWithProvider(
  set: ProductRecommendationSet,
  providerProducts: ProviderProductRecord[],
): ReconcileResult {
  const byId = new Map<string, ProviderProductRecord>();
  for (const p of providerProducts) {
    byId.set(`${p.productId}::${p.variantId ?? ""}`, p);
    // Also index without the variant, so a set that names a variant the
    // provider did not return still matches the product and simply loses
    // its Add to Cart.
    if (!byId.has(`${p.productId}::`)) byId.set(`${p.productId}::`, p);
  }

  const removed: RecommendedProduct[] = [];
  const corrections: ReconcileResult["corrections"] = [];
  const kept: RecommendedProduct[] = [];

  for (const product of set.products) {
    const exact = byId.get(`${product.productId}::${product.variantId ?? ""}`);
    const loose = byId.get(`${product.productId}::`);
    const record = exact ?? loose;
    if (!record) {
      removed.push(product);
      continue;
    }

    const note = (field: string, was: unknown, now: unknown) => {
      const a = was == null ? "" : String(was);
      const b = now == null ? "" : String(now);
      if (a !== b) corrections.push({ productId: product.productId, field, was: a, now: b });
    };

    note("productUrl", product.productUrl, record.productUrl);
    note("title", product.title, record.title);
    note("price", fmtMoney(product.price), fmtMoney(record.price));
    note("availability", product.availability, record.availability ?? "unknown");
    if (!exact && product.variantId) note("variantId", product.variantId, record.variantId ?? "");

    kept.push({
      ...product,
      // Provider truth, wholesale.
      productId: record.productId,
      variantId: exact ? record.variantId : record.variantId,
      title: record.title,
      productUrl: record.productUrl,
      price: record.price,
      compareAtPrice: record.compareAtPrice,
      availability: record.availability ?? "unknown",
      imageUrl: record.imageUrl,
      sku: record.sku,
      // Add to Cart is offered only when the provider says this exact
      // variant is purchasable AND the caller asked for that variant.
      purchasable: !!exact && record.purchasable === true && !!record.variantId,
      // The caller's to keep: prose, not facts.
      reason: product.reason,
      buttonLabel: product.buttonLabel,
    });
  }

  const next: ProductRecommendationSet = { ...set, products: kept };
  next.idempotencyKey = recommendationIdempotencyKey(next);
  return { set: next, removed, corrections };
}

function fmtMoney(m: RecommendationMoney | undefined): string {
  return m ? `${m.amount} ${m.currency}` : "";
}

// ─── Display helpers shared by every renderer ────────────────

export type RecommendationLocale = "he" | "en";

export const RECOMMENDATION_STRINGS: Record<RecommendationLocale, Record<string, string>> = {
  en: {
    viewProduct: "View product",
    addToCart: "Add to cart",
    inStock: "In stock",
    lowStock: "Low stock",
    outOfStock: "Out of stock",
    here: "Here is what I found:",
    was: "was",
  },
  he: {
    viewProduct: "לצפייה במוצר",
    addToCart: "הוספה לסל",
    inStock: "במלאי",
    lowStock: "כמות מוגבלת",
    outOfStock: "אזל מהמלאי",
    here: "הנה מה שמצאתי:",
    was: "היה",
  },
};

export function availabilityLabel(
  availability: RecommendationAvailability | undefined,
  locale: RecommendationLocale,
): string | null {
  const s = RECOMMENDATION_STRINGS[locale] ?? RECOMMENDATION_STRINGS.en;
  switch (availability) {
    case "in_stock":
      return s.inStock;
    case "low_stock":
      return s.lowStock;
    case "out_of_stock":
      return s.outOfStock;
    default:
      // "unknown" is silence, not a label. Telling a shopper the stock
      // level is unknown answers a question they did not ask and casts
      // doubt on a product that may be perfectly available.
      return null;
  }
}

/**
 * Price as one string, in the STORE's currency, exactly as the provider
 * quoted it. Deliberately not Intl-formatted: a locale-aware formatter
 * rounds, and a rounded price is a different price.
 */
export function priceLabel(price: RecommendationMoney | undefined): string | null {
  if (!price) return null;
  return `${price.amount} ${price.currency}`;
}
