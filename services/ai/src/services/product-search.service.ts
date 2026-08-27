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
  /**
   * Set when the shopper named a budget in a currency the store does not price
   * in ("עד 800 שקל" against a USD catalog).
   *
   * This used to be invisible, and the consequence was severe: the display
   * currency was taken from the BUDGET, so a $749.95 board was shown to an
   * Israeli shopper as "ILS 749.95" - the store's number wearing the
   * customer's currency, understating the price roughly fourfold. Prices are
   * always shown in the store's currency; when the budget is in another one we
   * say so and stop making over/under-budget claims we cannot substantiate
   * without an FX rate.
   */
  budgetCurrencyMismatch?: { budget: string; shop: string };
  /**
   * The COMPARABLE budget, in the store's own currency, when there is one.
   *
   * Present only when a comparison is actually valid - absent on a
   * currency mismatch, exactly like `comparableBudget` inside the
   * normalizer. Carried on the envelope because downstream has to make a
   * real selection decision with it (exclude an over-budget product,
   * label one that is kept), and re-deriving a budget from the model's
   * prose is how a USD 729.95 board reached a shopper who said 700.
   */
  budget?: { target: number; currency: string };
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

  // Shopify's OWN verdict first. `availableForSale` accounts for tracking,
  // stock, the oversell policy and location availability all at once, and the
  // GraphQL search carries it as `available`.
  //
  // It has to come first, because the fallback below reads
  // `inventory_management` - a field the GraphQL mapper does not emit. Every
  // searched product therefore looked UNTRACKED, and untracked means "always
  // available", so the entire catalogue rendered "במלאי". A product literally
  // named "The Out of Stock Snowboard", sitting at inventory_quantity 0, was
  // offered to a customer as in stock.
  if (typeof variant.available === "boolean") {
    return variant.available ? "in_stock" : "out_of_stock";
  }

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
  // `budget` is passed as undefined by the caller when its currency does not
  // match the store's, so a shekel target is never compared against a dollar
  // price. Comparing the raw numbers across currencies is not a rounding
  // error, it is a different answer.
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
  shopCurrency: string | undefined,
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
  // The STORE's currency, never the shopper's. Taking it from the budget
  // stamped "ILS" on prices Shopify quoted in USD. When the store currency is
  // unknown we show the bare number: an unlabelled price is ambiguous, a
  // wrongly-labelled one is false.
  const currency = shopCurrency;

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
    /** The store's own currency, from Shopify. Never the shopper's. */
    shopCurrency?: string;
  },
): ProductSearchEnvelope {
  const list = Array.isArray(rawProducts) ? rawProducts : [];
  const requested = opts.requestedFilters ?? [];

  // A budget only counts as a budget when it is denominated in the same
  // currency as the prices. Otherwise it is dropped for comparison purposes
  // and reported as a mismatch, so the shopper is told the prices are in the
  // store's currency instead of being quietly told the wrong thing.
  const mismatch =
    opts.budget && opts.shopCurrency && opts.budget.currency !== opts.shopCurrency
      ? { budget: opts.budget.currency, shop: opts.shopCurrency }
      : undefined;
  const comparableBudget = mismatch ? undefined : opts.budget;

  const candidates = list.map((raw) =>
    normalizeOne(raw, opts.shopDomain, comparableBudget, opts.shopCurrency),
  );

  // appliedFilters: the filters Shopify actually honored.
  const appliedFilters: string[] = [];
  if (requested.includes("query")) appliedFilters.push("query");
  if (comparableBudget) appliedFilters.push("budget");

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
    ...(mismatch ? { budgetCurrencyMismatch: mismatch } : {}),
    ...(comparableBudget ? { budget: comparableBudget } : {}),
  };
}

/**
 * The MODEL-VISIBLE representation. The model never sees raw URLs/ids/prices to
 * copy; it sees stable keys (PRODUCT_1..N) plus safe descriptive facts, and is
 * told to REFERENCE products by key. The deterministic renderer later resolves
 * those keys against the canonical envelope. This is the "safe structured
 * summary" stage - the model reasons, it does not reproduce identity.
 */
export function buildKeyedModelSummary(
  env: ProductSearchEnvelope,
  locale: "he" | "en",
): string {
  if (env.status === "error") {
    return "PRODUCT_SEARCH_FAILED: the live catalog could not be read. Do NOT claim a search ran or that there are no products; tell the customer you can't check the catalog right now and offer a human handoff.";
  }
  if (env.status === "no_results" || env.candidates.length === 0) {
    // Naming the constraint matters now that the budget is a REAL filter on the
    // query rather than a label applied afterwards. An empty result used to be
    // impossible - the shopper got three over-budget boards and a sentence
    // saying none of them fitted - and the honest empty answer that replaced it
    // is only useful if the next sentence can say what the store DOES start at.
    // The model is told to go and find that out rather than estimate it.
    const budgeted = env.appliedFilters.includes("budget");
    return (
      "PRODUCT_SEARCH_RESULTS: 0 products matched" +
      (budgeted ? ` (the search was limited to ${env.budget?.currency ?? ""} ${env.budget?.target ?? ""} and under).` : ".") +
      " State honestly that nothing matched. Do NOT invent products and do NOT offer something you were not shown." +
      (budgeted
        ? " Before replying, run the SAME search again WITHOUT price_max so you can tell the customer the real lowest price in this category, then let them decide whether to raise their budget. Never guess that number."
        : " Offer ONE controlled refinement (widen length, raise budget, or preorder).")
    );
  }
  const lines = env.candidates.map((c, i) => {
    const key = `PRODUCT_${i + 1}`;
    const price = c.price !== undefined ? `${c.currency ?? ""} ${c.price}`.trim() : "unknown price";
    const avail =
      c.inventoryState === "in_stock" ? "in stock" :
      c.inventoryState === "out_of_stock" ? "out of stock" : "availability unknown";
    const match = c.matchQuality === "approximate" ? "approximate/over-budget" : "within budget";
    // Unknown attributes are listed ONLY when the shopper actually asked about
    // them. Volunteering "flex: unknown, riding style: unknown, length:
    // unknown" reads as a system dumping empty fields at a customer who never
    // raised them; the honesty rule is "never invent", not "always recite".
    const askedUnknown = c.unknownAttributes.filter((a) =>
      env.unavailableFilters.includes(a) || env.unavailableFilters.includes(a.replace("board_", "")),
    );
    const unknown = askedUnknown.length ? ` | unknown: ${askedUnknown.join(", ")}` : "";
    return `${key}: "${c.title}" | ${price} | ${avail} | ${match}${unknown}`;
  });
  const fx = env.budgetCurrencyMismatch
    ? [
        "",
        `BUDGET CURRENCY MISMATCH: the shopper's budget is in ${env.budgetCurrencyMismatch.budget} but this store prices in ${env.budgetCurrencyMismatch.shop}. ` +
          `Say plainly that prices are in ${env.budgetCurrencyMismatch.shop}. Do NOT claim any product is within or over their budget, and do NOT convert - you have no exchange rate.`,
      ]
    : [];
  return [
    "PRODUCT_SEARCH_RESULTS (reference products ONLY by their key, e.g. PRODUCT_1):",
    ...lines,
    ...fx,
    "",
    "Rules: reference candidates by key. Do NOT write product URLs, prices, or availability yourself - the system attaches the exact values below your text. Do NOT re-list the products as a bulleted catalogue either; that list is already appended, and repeating it just prints every title twice. Write only the short reasoning a person would say out loud, naming at most two or three keys inline. Do NOT mention any product not listed above. Never invent flex, riding style or board length; if the shopper asks for one and it is marked unknown, say that detail is not listed for this product.",
    "",
    "NEVER ASK PERMISSION TO SHOW THE PRODUCTS (CRITICAL). On a channel with product cards the system attaches them to this very message, automatically, without you calling anything. So do NOT write \"would you like me to send a product card?\", \"רוצה שאשלח כרטיסי מוצר?\", \"אפשר להציג לך את המוצרים?\" or any variant. Offering, as a favour, the thing that is already happening reads as a system asking permission to do its job. Write the short lead-in as though the products are already visible below your text, because they are.",
    "BUDGET HONESTY (CRITICAL). Each candidate above is marked either `within budget` or `approximate/over-budget`, computed from the store's own prices. NEVER say or imply that every option matches the budget when any one of them is marked over-budget. If you name an over-budget option, say plainly that it is above what they asked for. Do not do the arithmetic yourself and do not contradict the marking.",
  ].join("\n");
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const MONEY_RE = /(?:[$₪€£]|USD|ILS|EUR|GBP)\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|ILS|EUR|GBP|\$|₪)/gi;

/**
 * Deterministic grounded renderer: resolve the model's PRODUCT_n references
 * against the canonical envelope and attach EXACT product fields. The model's
 * prose is reasoning only - any URL or price it emitted is stripped, so it can
 * never substitute a URL, alter a price/currency, flip availability, or invent
 * a product. References to products that don't exist are blocked. A malformed /
 * reference-less reply falls back to the full deterministic list. Pure.
 */
export function renderGroundedProductReply(
  modelText: string | null | undefined,
  env: ProductSearchEnvelope,
  locale: "he" | "en",
): { message: string; blocked: string[]; grounded: boolean; usedFallback: boolean } {
  // Provider failure must never read as no-results.
  if (env.status === "error") {
    return {
      message: locale === "he"
        ? "לא הצלחתי לגשת לקטלוג החי כרגע. אני יכולה לחבר אותך לנציג מהצוות שיבדוק עבורך."
        : "I couldn't reach the live catalog just now. I can connect you with a person from the team to check for you.",
      blocked: [], grounded: true, usedFallback: true,
    };
  }
  if (env.status === "no_results" || env.candidates.length === 0) {
    return { message: renderCandidatesForWhatsApp(env, locale), blocked: [], grounded: true, usedFallback: false };
  }

  const text = (modelText ?? "").trim();
  const refTokens = Array.from(text.matchAll(/PRODUCT_(\d+)/gi)).map((m) => Number(m[1]));
  const validRefs = Array.from(new Set(refTokens.filter((n) => n >= 1 && n <= env.candidates.length)));
  const blocked = Array.from(new Set(refTokens.filter((n) => n < 1 || n > env.candidates.length))).map((n) => `PRODUCT_${n}`);

  // Which candidates to present: the referenced ones, else a bounded head.
  //
  // The fallback used to emit EVERY candidate. Asked "do you have The Minimal
  // Snowboard in a 159?" the shopper got a fourteen-product catalogue dump,
  // because the model referenced no key and the renderer took that as licence
  // to print the lot. When we do not know which products the answer is about,
  // a short list is a suggestion and a long one is noise.
  const FALLBACK_LIMIT = 5;
  const usedFallback = validRefs.length === 0;
  const chosen = usedFallback
    ? env.candidates.slice(0, FALLBACK_LIMIT)
    : validRefs.map((n) => env.candidates[n - 1]);

  // Model prose becomes reasoning ONLY: strip any URL/price it emitted (exact
  // values come from the canonical block below), replace PRODUCT_n tokens with
  // the real title so the prose reads naturally, and drop invalid refs.
  let prose = text
    .replace(/PRODUCT_(\d+)/gi, (_, d) => {
      const n = Number(d);
      return n >= 1 && n <= env.candidates.length ? env.candidates[n - 1].title : "";
    })
    .replace(URL_RE, "")
    .replace(MONEY_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // If nothing usable remains, no prose (the deterministic list stands alone).
  if (usedFallback || prose.length < 3) prose = "";

  // Canonical block: EXACT fields from the envelope only.
  const inStockLabel = locale === "he" ? "במלאי" : "in stock";
  const outLabel = locale === "he" ? "אזל מהמלאי" : "out of stock";
  const overBudget = locale === "he" ? "מעט מעל התקציב" : "slightly over budget";
  const blocks = chosen.map((c, i) => {
    const parts = [`${i + 1}. ${c.title}`];
    if (c.price !== undefined) parts.push([c.currency, c.price].filter(Boolean).join(" "));
    if (c.matchQuality === "approximate") parts[parts.length - 1] += ` (${overBudget})`;
    if (c.inventoryState === "in_stock") parts.push(inStockLabel);
    else if (c.inventoryState === "out_of_stock") parts.push(outLabel);
    parts.push(c.url);
    return parts.join("\n");
  });

  const header = locale === "he" ? "הנה מה שמצאתי:" : "Here's what I found:";
  // The currency notice is rendered DETERMINISTICALLY, not left to the model.
  // When no PRODUCT_n reference survives, prose is dropped entirely - and a
  // shopper who asked "עד 800 שקל" would then receive a bare list of USD
  // prices, several of them far above their budget, with nothing saying so.
  // Only when the model said nothing. If it already explained the currency in
  // its own words, appending the canned line says the same thing twice.
  const fxNotice = env.budgetCurrencyMismatch && !prose
    ? locale === "he"
      ? `שים לב: המחירים בחנות הם ב-${env.budgetCurrencyMismatch.shop}, ולכן לא השוויתי אותם לתקציב שציינת ב-${env.budgetCurrencyMismatch.budget}.`
      : `Note: this store prices in ${env.budgetCurrencyMismatch.shop}, so I have not compared these against the budget you gave in ${env.budgetCurrencyMismatch.budget}.`
    : undefined;
  const message = [prose, prose ? "" : header, fxNotice, ...blocks]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { message, blocked, grounded: true, usedFallback };
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
