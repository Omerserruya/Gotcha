/**
 * Typed Shopify product-search result envelope.
 *
 * Purpose (architectural failure #3 fix): product data must NOT be flattened
 * into untyped model text too early. The model should receive only a short,
 * safe textual summary, while the caller retains the FULL typed envelope for
 * deterministic rendering (WhatsApp/UI). URLs, ids, and prices are preserved
 * as exact atoms and are NEVER model-generated or reformatted.
 */

export interface ProductCandidate {
  title: string;
  productId: string;
  variantId?: string;
  sku?: string;
  price?: string;
  currency?: string;
  inventoryState: "in_stock" | "out_of_stock" | "unknown";
  url: string;
  imageUrl?: string;
  attributes: Record<string, string | number>;
  unknownAttributes: string[];
  matchQuality: "exact" | "approximate";
}

export interface ProductSearchEnvelope {
  provider: "shopify";
  tool: string;
  executionId?: string;
  status: "ok" | "no_results" | "error";
  candidates: ProductCandidate[];
  appliedFilters: string[];
  unavailableFilters: string[];
  safeModelSummary: string;
}

/**
 * Discovery attributes shoppers care about that Shopify has NO structured
 * field for. These must always be surfaced as unknown (never invented) and,
 * when requested as filters, reported as unavailable.
 */
const SHOPIFY_UNKNOWN_ATTRIBUTES: readonly string[] = [
  "riding_style",
  "flex",
  "board_length",
];

/**
 * Map of requested filter name -> whether Shopify can actually apply it.
 * The discovery attributes above cannot be filtered server-side by Shopify.
 */
const SHOPIFY_UNFILTERABLE: readonly string[] = ["riding_style", "flex", "length"];

function firstVariant(raw: any): any | undefined {
  if (!raw || !Array.isArray(raw.variants) || raw.variants.length === 0) {
    return undefined;
  }
  return raw.variants[0];
}

function pickImageUrl(raw: any): string | undefined {
  if (raw?.image?.src && typeof raw.image.src === "string") {
    return raw.image.src;
  }
  if (
    Array.isArray(raw?.images) &&
    raw.images.length > 0 &&
    typeof raw.images[0]?.src === "string"
  ) {
    return raw.images[0].src;
  }
  return undefined;
}

/**
 * Derive inventory state from the first variant.
 * - in_stock: inventory_quantity > 0 OR inventory_management is null (untracked)
 * - out_of_stock: inventory_quantity === 0
 * - unknown: anything else (e.g. missing variant / unreadable quantity)
 */
function deriveInventoryState(
  variant: any | undefined,
): "in_stock" | "out_of_stock" | "unknown" {
  if (!variant) return "unknown";

  const tracked =
    variant.inventory_management !== null &&
    variant.inventory_management !== undefined;

  if (!tracked) {
    // Untracked inventory -> Shopify treats as always available.
    return "in_stock";
  }

  const qty = variant.inventory_quantity;
  if (typeof qty === "number") {
    if (qty > 0) return "in_stock";
    if (qty === 0) return "out_of_stock";
  }
  return "unknown";
}

/**
 * Structured product attributes Shopify DOES store. Preserved as-is (exact
 * strings), only including fields that are actually present and non-empty.
 */
function collectAttributes(raw: any): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};
  const candidates: Array<[string, unknown]> = [
    ["product_type", raw?.product_type],
    ["vendor", raw?.vendor],
    ["status", raw?.status],
  ];
  for (const [key, value] of candidates) {
    if (typeof value === "string" && value.length > 0) {
      attrs[key] = value;
    } else if (typeof value === "number") {
      attrs[key] = value;
    }
  }
  return attrs;
}

/**
 * matchQuality: when a budget is given, a candidate is "exact" if its price is
 * within 5% of the target, otherwise "approximate". Without a budget, every
 * candidate is "exact" (no budget dimension to approximate against).
 */
function deriveMatchQuality(
  price: string | undefined,
  budget: { target: number; currency: string } | undefined,
): "exact" | "approximate" {
  if (!budget) return "exact";
  if (price === undefined) return "approximate";
  const numeric = Number(price);
  if (!Number.isFinite(numeric)) return "approximate";
  return numeric <= budget.target * 1.05 ? "exact" : "approximate";
}

function normalizeOne(
  raw: any,
  shopDomain: string,
  budget: { target: number; currency: string } | undefined,
): ProductCandidate {
  const variant = firstVariant(raw);

  // Preserve ids/prices as EXACT strings. Never reformat numbers.
  const productId = raw?.id !== undefined && raw?.id !== null ? String(raw.id) : "";
  const variantId =
    variant && variant.id !== undefined && variant.id !== null
      ? String(variant.id)
      : undefined;
  const sku =
    variant && typeof variant.sku === "string" && variant.sku.length > 0
      ? variant.sku
      : undefined;
  const price =
    variant && variant.price !== undefined && variant.price !== null
      ? String(variant.price)
      : undefined;
  const currency = budget?.currency;

  // URL is built atomically from the handle - never model-generated.
  const handle = typeof raw?.handle === "string" ? raw.handle : "";
  const url = `https://${shopDomain}/products/${handle}`;

  return {
    title: typeof raw?.title === "string" ? raw.title : "",
    productId,
    variantId,
    sku,
    price,
    currency,
    inventoryState: deriveInventoryState(variant),
    url,
    imageUrl: pickImageUrl(raw),
    attributes: collectAttributes(raw),
    unknownAttributes: [...SHOPIFY_UNKNOWN_ATTRIBUTES],
    matchQuality: deriveMatchQuality(price, budget),
  };
}

function buildSafeModelSummary(candidates: ProductCandidate[]): string {
  if (candidates.length === 0) {
    return "No matching products found.";
  }
  return candidates
    .map((c, i) => {
      const pricePart =
        c.price !== undefined
          ? ` ${[c.currency, c.price].filter(Boolean).join(" ")}`.trimEnd()
          : "";
      return `${i + 1}. ${c.title}${pricePart} (${c.matchQuality})`;
    })
    .join("\n");
}

export function normalizeShopifyProducts(
  rawProducts: any[],
  opts: {
    shopDomain: string;
    budget?: { target: number; currency: string };
    requestedFilters?: string[];
  },
): ProductSearchEnvelope {
  const list = Array.isArray(rawProducts) ? rawProducts : [];
  const requested = opts.requestedFilters ?? [];

  const candidates = list.map((raw) =>
    normalizeOne(raw, opts.shopDomain, opts.budget),
  );

  // appliedFilters: the filters Shopify actually honored.
  const appliedFilters: string[] = [];
  if (requested.includes("query")) appliedFilters.push("query");
  if (opts.budget) appliedFilters.push("budget");

  // unavailableFilters: requested discovery filters Shopify can't apply.
  const unavailableFilters = SHOPIFY_UNFILTERABLE.filter((f) =>
    requested.includes(f),
  );

  const status: ProductSearchEnvelope["status"] =
    candidates.length === 0 ? "no_results" : "ok";

  return {
    provider: "shopify",
    tool: "shopify_product_search",
    status,
    candidates,
    appliedFilters,
    unavailableFilters,
    safeModelSummary: buildSafeModelSummary(candidates),
  };
}

/**
 * Render candidates as a clean, readable WhatsApp list using EXACT url/price.
 * No em dashes, no invented attributes. Honest no-results line when empty.
 */
export function renderCandidatesForWhatsApp(
  env: ProductSearchEnvelope,
  locale: "he" | "en",
): string {
  if (env.status === "no_results" || env.candidates.length === 0) {
    return locale === "he"
      ? "לא מצאתי מוצרים שמתאימים לחיפוש הזה."
      : "I couldn't find any products matching that search.";
  }

  const header =
    locale === "he" ? "הנה מה שמצאתי:" : "Here's what I found:";

  const lines = env.candidates.map((c, i) => {
    const parts: string[] = [`${i + 1}. ${c.title}`];
    if (c.price !== undefined) {
      const priceStr = [c.currency, c.price].filter(Boolean).join(" ");
      parts.push(priceStr);
    }
    parts.push(c.url);
    return parts.join("\n");
  });

  return [header, ...lines].join("\n\n");
}
