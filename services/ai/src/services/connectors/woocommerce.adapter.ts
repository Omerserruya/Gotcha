/**
 * WooCommerce adapter - production-grade.
 *
 * Auth: REST API consumer key + consumer secret (no OAuth). The store
 * URL is stored in `config.storeUrl` (e.g. "https://shop.example.com").
 * Credentials hold `{ consumerKey, consumerSecret }`. The REST client
 * uses HTTP Basic auth with these values per Woo's standard auth flow.
 *
 * Tools (top support + sales use-cases on WooCommerce):
 *   - woocommerce.list_orders          - recent orders (filterable)
 *   - woocommerce.get_order            - single order detail
 *   - woocommerce.update_order_status  - change status (processing/completed/cancelled/refunded)
 *   - woocommerce.get_customer         - by id or email
 *   - woocommerce.search_customers     - by partial fields
 *   - woocommerce.list_products        - search by name
 *   - woocommerce.create_coupon        - issue a discount coupon (HIGH risk)
 *
 * API: WC REST v3 - /wp-json/wc/v3/
 */

import { assertPublicUrl, getRedis } from "@chatcenter/shared";
import { orderPhoneSearchTerms } from "../../lib/order-phone-search";
import { rememberListed, setStoreAllowedProducts, wooProductAllowed, wooStoreHasAllowList } from "./woo-listed-products";
export { recentlyListedWooProduct } from "./woo-listed-products";
export { orderPhoneSearchTerms };
import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";
import { SHIPMENT_TRACKING_NAMESPACE, recordShipmentTracking } from "./woo-shipment-tracking";

const TOOLS: ToolDefinition[] = [
  {
    name: "woocommerce.list_orders",
    description: "List recent WooCommerce orders, filterable by status or customer email.",
    whenToUse: "Customer asks about an order or you need order context.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "checkout-draft", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "any"] },
        email: { type: "string", description: "Filter by billing email." },
        per_page: { type: "number", description: "Default 10, max 100." },
      },
    },
  },
  {
    name: "woocommerce.get_order",
    description: "Get one WooCommerce order by id.",
    whenToUse: "You have an order id and need full detail (line items, totals, addresses, fulfillment).",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "woocommerce.update_order_status",
    description: "Change the status of an existing WooCommerce order.",
    whenToUse: "Order needs a status transition (cancel, mark complete, etc.) and the action is approved.",
    whenNotToUse: "You're guessing at status - confirm the customer's intent first.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Updates the order status visible to merchant + customer; may trigger emails.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        status: { type: "string", enum: ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] },
        note: { type: "string", description: "Optional customer-visible note." },
      },
      required: ["order_id", "status"],
    },
  },
  {
    name: "woocommerce.get_customer",
    description: "Get a WooCommerce customer by id or email.",
    whenToUse: "You need standing context (lifetime spend, recent orders) for a known customer.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        email: { type: "string" },
      },
    },
  },
  {
    name: "woocommerce.search_customers",
    description: "Search REGISTERED WooCommerce customers by partial email/name. Guest checkouts are not customers and phone is not searched: to find someone's orders use woocommerce.list_customer_orders.",
    whenToUse: "Identifying a customer with partial info.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        per_page: { type: "number", description: "Default 10, max 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "woocommerce.list_products",
    description: "Search the store's published WooCommerce products by name/SKU, optionally within a price range or in stock only.",
    whenToUse: "Customer asks about a product, or you need to surface options.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product name or SKU fragment." },
        per_page: { type: "number", description: "Default 10, max 100." },
        price_min: { type: "number", description: "Lowest price, in the store's currency." },
        price_max: { type: "number", description: "Highest price (the customer's budget), in the store's currency." },
        in_stock: { type: "boolean", description: "true = only products in stock." },
        audience: {
          type: "string",
          enum: ["men", "women"],
          description: "Who it is for, when the customer said (a man / a woman, for himself / for herself): only the store's products for them. Leave out otherwise.",
        },
      },
    },
  },
  {
    name: "woocommerce.create_coupon",
    description: "Create a discount coupon: a percentage off, or a fixed amount off the cart.",
    whenToUse: "Customer is being offered a documented discount. Approval is handled by the system: calling this tool is what RAISES the approval, so call it whenever the customer's request warrants it. Never wait for approval before calling, and never hand the conversation to a human merely because approval is needed.",
    whenNotToUse: "Speculative or unconfirmed discount offers.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Creates a coupon code that can be used by anyone who knows the code.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "For a store credit (instead of a refund): the order it replaces. The coupon is then usable only by that order's customer. Required from a customer conversation." },
        code: { type: "string", description: "Coupon code customers will type." },
        amount: { type: "string", description: "Percentage ('10' = 10%), or a fixed amount in the store's currency when discount_type is fixed_cart." },
        discount_type: { type: "string", enum: ["percent", "fixed_cart"], description: "percent (default) or a fixed amount off the cart." },
        usage_limit: { type: "number", description: "Max redemptions. Default 1." },
        expires_iso: { type: "string", description: "ISO8601 expiry date." },
      },
      required: ["code", "amount"],
    },
  },
  // ── Added 2026-10-13 (Omer: "everything that's missing") ──────────────
  {
    name: "woocommerce.list_order_notes",
    description: "The notes on an order: what the store and the customer wrote, and system notes.",
    whenToUse: "The customer asks what happened with their order, or you need the store's notes on it.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "woocommerce.add_order_note",
    description: "Add a note to an order. A customer-visible note is emailed to the customer by WooCommerce.",
    whenToUse: "Something about the order should be recorded for the store, or told to the customer in writing.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Adds a note to the order; a customer note is emailed to the customer.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        note: { type: "string" },
        customer_visible: { type: "boolean", description: "true = the customer sees it (and gets an email). Default false." },
      },
      required: ["order_id", "note"],
    },
  },
  {
    name: "woocommerce.list_refunds",
    description: "The refunds already made on an order, with amounts and reasons.",
    whenToUse: "The customer asks whether, or how much, they were refunded.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "woocommerce.create_refund",
    description: "Refund an order, fully or partly, through the store's payment gateway.",
    whenToUse: "A refund the store's policy allows has been agreed. Approval is handled by the system: calling this tool is what raises it.",
    whenNotToUse: "The amount or the order is not confirmed with the customer.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Moves money back to the customer through the payment gateway and records a refund on the order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        amount: { type: "string", description: "Amount to refund in the order's currency, e.g. '49.90'." },
        reason: { type: "string" },
      },
      required: ["order_id", "amount"],
    },
  },
  {
    name: "woocommerce.cancel_order",
    description: "Cancel an order that has not been fulfilled.",
    whenToUse: "The customer asks to cancel and the order can still be cancelled. Approval is handled by the system.",
    whenNotToUse: "The order already shipped or completed: offer a return or a refund instead.",
    category: "WRITE",
    riskLevel: "HIGH",
    sideEffects: "Sets the order to cancelled; stock is restored and the customer may be emailed.",
    parameters: {
      type: "object",
      properties: { order_id: { type: "string" }, note: { type: "string", description: "Optional customer-visible note." } },
      required: ["order_id"],
    },
  },
  {
    name: "woocommerce.update_shipping_address",
    description: "Change the shipping address of an order that has not shipped.",
    whenToUse: "The customer gives a corrected delivery address before the order ships.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Changes where the order is delivered.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        address_1: { type: "string" }, address_2: { type: "string" }, city: { type: "string" },
        postcode: { type: "string" }, country: { type: "string" }, state: { type: "string" },
        first_name: { type: "string" }, last_name: { type: "string" }, phone: { type: "string" },
      },
      required: ["order_id", "address_1", "city"],
    },
  },
  {
    name: "woocommerce.update_customer",
    description: "Update a customer's name, email or phone.",
    whenToUse: "The customer asks to correct their details.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Changes the customer's record in the store.",
    parameters: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "woocommerce.create_customer",
    description: "Create a customer account in the store.",
    whenToUse: "A new customer asks to be registered and gave at least an email.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Creates a customer account (WooCommerce may email them).",
    parameters: {
      type: "object",
      properties: { email: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, phone: { type: "string" } },
      required: ["email"],
    },
  },
  {
    name: "woocommerce.get_product",
    description: "One product with its price and stock (quantity and in-stock status).",
    whenToUse: "The customer asks about a specific product, its price or whether it is in stock.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
  },
  {
    // Internal callers only (the web chat's add-ons read the category tree).
    // Declared so the framework will run it; no catalog row exists, so the
    // governance gate never offers it to the model (dev 2026-10-27: undeclared,
    // it was refused as unknown_tool and the Wool Blend Overcoat got no add-ons).
    name: "woocommerce.list_product_categories",
    description: "The store's product categories (id, name, parent).",
    whenToUse: "Internal: the add-ons read the category tree.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "woocommerce.list_product_variations",
    description: "The variations of a product (size, color...) with price and stock for each.",
    whenToUse: "The customer asks which sizes or colors are available, or in stock.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { product_id: { type: "string" }, per_page: { type: "number" } }, required: ["product_id"] },
  },
  {
    name: "woocommerce.list_coupons",
    description: "The store's coupons.",
    whenToUse: "You need to see which coupons exist.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        per_page: { type: "number" },
        page: { type: "number", description: "Page of results, from 1." },
        ids: { type: "array", items: { type: "string" }, description: "Only these coupon ids." },
      },
    },
  },
  {
    name: "woocommerce.get_coupon",
    description: "Check a coupon code: whether it exists and is still valid (expiry, usage left), and what it gives.",
    whenToUse: "The customer asks whether a coupon code works.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "woocommerce.disable_coupon",
    description: "Stop a coupon from being used.",
    whenToUse: "The store asks to withdraw a coupon.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "The coupon can no longer be applied.",
    parameters: { type: "object", properties: { coupon_id: { type: "string" }, code: { type: "string" } } },
  },
  {
    name: "woocommerce.list_customer_orders",
    description: "The customer's orders, newest first, found by their phone and/or email on the order itself: this finds guest-checkout orders too.",
    whenToUse: "The customer asks about their orders without an order number. Call it with no arguments to search by the customer's own phone and email; never by a phone or email given for someone else.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The customer's phone, any format (05x, +972, with dashes)." },
        email: { type: "string" },
        customer_id: { type: "string", description: "A registered customer's id. Guest orders have none." },
        per_page: { type: "number" },
      },
    },
  },
  {
    name: "woocommerce.get_shipment_tracking",
    description: "Tracking numbers and links for an order (needs the WooCommerce Shipment Tracking extension).",
    whenToUse: "The customer asks where their package is.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
];


const AUDIENCE_NAME: Record<"men" | "women", RegExp> = {
  men: /^(?:men|mens|men'?s|man|male|גברים|גבר)$/i,
  women: /^(?:women|womens|women'?s|woman|female|נשים|אישה)$/i,
};
const audienceCache = new Map<string, { at: number; ids: Record<string, string | null> }>();

/** The store's top-level category for men or women (its id), or null; cached ten minutes per store. */
async function audienceCategory(auth: string, base: string, audience: "men" | "women"): Promise<string | null> {
  const hit = audienceCache.get(base);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ids[audience] ?? null;
  const list: any = await wooRequest(auth, "GET", `${base}/products/categories?per_page=100&hide_empty=true`).catch(() => null);
  if (!Array.isArray(list)) return null;
  const name = (c: any) => String(c?.name ?? "").replace(/&amp;/g, "&").trim();
  const find = (a: "men" | "women") => {
    const c = list.find((x: any) => String(x?.parent ?? "0") === "0" && AUDIENCE_NAME[a].test(name(x)));
    return c ? String(c.id) : null;
  };
  const ids = { men: find("men"), women: find("women") };
  audienceCache.set(base, { at: Date.now(), ids });
  return ids[audience];
}

const categoryCache = new Map<string, { at: number; list: any[] }>();

/** A word's stem for matching a category name: "accessory" and "Accessories" are one, "dresses" and "Dress". */
function categoryStem(word: string): string {
  const w = word.toLowerCase();
  if (/ies$/.test(w)) return w.slice(0, -3) + "i";
  if (/y$/.test(w) && w.length > 3) return w.slice(0, -1) + "i";
  if (/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  return w.replace(/(?<!s)s$/, "");
}

/**
 * A Hebrew word's stem for matching (Tehila 2026-11-04: her titles are names,
 * "אנה", "פרינט- קרואלה", so her 83 scarves are found only by her Hebrew
 * categories, and "מטפחה" / "מטפחת" / "מטפחות" must all reach "מטפחות").
 * Drops a leading ו/ה (only on a long word), a plural ות/ים, then a final ה/ת:
 * מטפחה = מטפחת = מטפחות -> מטפח, חגיגית = חגיגיות -> חגיגי, החדשה -> חדש.
 */
export function hebrewStem(word: string): string {
  let w = word.replace(/[֑-ׇ"'׳״]/g, "");
  if (w.length > 4 && w.startsWith("וה")) w = w.slice(2);
  else if (w.length > 4 && /^[הו]/.test(w)) w = w.slice(1);
  if (w.length > 4 && /(ות|ים)$/.test(w)) w = w.slice(0, -2).replace(/א$/, "");
  if (w.length > 3 && /[הת]$/.test(w)) w = w.slice(0, -1);
  return w;
}

/**
 * Words that name the same thing across the two languages, or a store's own
 * name for it ("הקולקציה החדשה" is the "new in" category). Stems on both sides.
 */
const STEM_SYNONYMS: Record<string, string[]> = {
  "חדש": ["new"], "קולקצי": ["new"], "new": ["חדש"],
  scarf: ["מטפח"], scarv: ["מטפח"], hijab: ["מטפח"], headscarf: ["מטפח"], "מטפח": ["scarf"],
  earring: ["עגיל"], "עגיל": ["earring"], necklace: ["שרשר"], "שרשר": ["necklace"],
  bracelet: ["צמיד"], "צמיד": ["bracelet"], jewelri: ["תכשיט"], jewelleri: ["תכשיט"], "תכשיט": ["jewelri"],
};

/** Hebrew words that name nothing in a catalogue ("יש לכם", "עד 99 ש"ח"). */
const HEBREW_STOP = new Set(["דגם", "דגמ", "עד", "של", "יש", "לי", "את", "עם", "על", "אני", "לכם", "אתם", "מה", "זה", "גם", "או", "כל", "אם", "רק", "בלי", "יותר", "פחות", "אפשר", "רוצ", "מחפש", "שח", "ש\"ח", "בשביל", "משהו", "איז", "איזה"]);

/** A text's Hebrew stems, catalogue words only. */
function hebrewStems(t: string): string[] {
  return (t.match(/[א-ת"'׳״]{2,}/g) ?? []).map(hebrewStem).filter((w) => w.length >= 2 && !HEBREW_STOP.has(w));
}

/** The stems a text's words stand for, Latin and Hebrew, with their synonyms. */
export function queryStems(text: unknown): string[] {
  const t = String(text ?? "").toLowerCase()
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#8211;|&#8212;/g, "-").replace(/&#\d+;/g, " ");
  const latin = (t.match(/[a-z]{3,}/g) ?? []).map(categoryStem);
  const hebrew = hebrewStems(t);
  const own = Array.from(new Set([...latin, ...hebrew]));
  return Array.from(new Set([...own, ...own.flatMap((s) => STEM_SYNONYMS[s] ?? [])]));
}

/**
 * The store's category a search names (urban replay 2026-10-28: "accessory"
 * found no title, and the store's own search of category names misses
 * "Accessories" too, so the customer was told there were none). Matched by
 * stem, Latin or Hebrew, against the store's non-empty categories; the most
 * query words wins, then the narrowest name ("מטפחה חגיגית" is "מטפחות
 * חגיגיות", not all "מטפחות"). Never a Men / Women one, which is the audience
 * param's. Ten minutes' cache.
 */
/** The store's non-empty categories, ten minutes per store and language. */
async function storeCategories(auth: string, base: string, lang?: string | null): Promise<{ at: number; list: any[] } | null> {
  const key = lang ? `${base}|${lang}` : base;
  let hit = categoryCache.get(key);
  if (!hit || Date.now() - hit.at >= 10 * 60_000) {
    const list: any = await wooRequest(auth, "GET", `${base}/products/categories?per_page=100&hide_empty=true${lang ? `&lang=${lang}` : ""}`).catch(() => null);
    if (!Array.isArray(list)) return null;
    hit = { at: Date.now(), list };
    categoryCache.set(key, hit);
  }
  return hit;
}

/**
 * Is this store's catalogue in Hebrew? Read in Hebrew (a WPML store with
 * storeLanguage he), or most of its named categories are Hebrew (Tehila's
 * "מטפחות חגיגיות"; urban's "Jackets & Coats" is not).
 */
async function storeCatalogIsHebrew(auth: string, base: string, lang: string | null): Promise<boolean> {
  if (lang === "he") return true;
  const hit = await storeCategories(auth, base, lang);
  const names = (hit?.list ?? []).map((c: any) => String(c?.name ?? "")).filter((n: string) => n && !/^uncategori[sz]ed$/i.test(n));
  return names.length > 0 && names.filter((n: string) => /[א-ת]/.test(n)).length * 2 > names.length;
}

async function categoryForQuery(auth: string, base: string, query: unknown, lang?: string | null): Promise<{ id: string; name: string } | null> {
  const wanted = new Set(queryStems(query));
  if (!wanted.size) return null;
  const hit = await storeCategories(auth, base, lang);
  if (!hit) return null;
  let best: { id: string; name: string; score: number; size: number; count: number } | null = null;
  for (const c of hit.list) {
    const name = String(c?.name ?? "").replace(/&amp;/g, "&").trim();
    if (!(Number(c?.count) > 0) || AUDIENCE_NAME.men.test(name) || AUDIENCE_NAME.women.test(name)) continue;
    // The name's own stems, without synonyms: a match is the query's word in the name.
    const t = name.toLowerCase().replace(/&quot;/g, '"').replace(/&#\d+;/g, " ");
    const stems = Array.from(new Set([...(t.match(/[a-z]{3,}/g) ?? []).map(categoryStem), ...hebrewStems(t)]));
    const score = stems.filter((x) => wanted.has(x)).length;
    const count = Number(c.count);
    if (score && (!best || score > best.score || (score === best.score && stems.length < best.size))) {
      best = { id: String(c.id), name, score, size: stems.length, count };
    }
  }
  return best ? { id: best.id, name: best.name } : null;
}

/** Does a product's name hold this word, in any of its forms (Hebrew stem, or the word itself)? */
function nameHolds(p: any, word: string): boolean {
  const name = String(p?.name ?? "").toLowerCase();
  const w = word.toLowerCase();
  if (name.includes(w)) return true;
  const stem = /[א-ת]/.test(w) ? hebrewStem(w) : categoryStem(w);
  return stem.length >= 2 && (hebrewStems(name).includes(stem) || name.includes(stem));
}

/** "מטפחה" -> ["מטפחת", "מטפחות", "מטפח"]: the other forms of a Hebrew word, to retry an empty title search. */
export function hebrewVariants(word: string): string[] {
  const s = hebrewStem(word);
  if (s.length < 2) return [];
  return Array.from(new Set([s + "ת", s + "ה", s + "ות", s + "ים", s])).filter((v) => v !== word);
}

/** Words of a general stock ask, stemmed ("מה יש כרגע במלאי", "אילו מוצרים זמינים"). */
const STOCK_ASK = new Set(["במלאי", "מלאי", "כרגע", "עכשיו", "זמינ", "זמין", "מוצר", "הכל", "אצלכ", "אצלכם", "אילו", "חדש"].map((w) => hebrewStem(w)));

/** In stock first, keeping each group's order. */
function inStockFirst(list: any[]): any[] {
  const out = (p: any) => p?.stock_status === "outofstock";
  return [...list.filter((p) => !out(p)), ...list.filter(out)];
}

/**
 * The categories a connection limits customers to: config.productCategoryIds,
 * numeric ids (a WPML store's languages have their own, so both). Null: all.
 */
export function categoryAllowList(config: any): Set<string> | null {
  const ids = (Array.isArray(config?.productCategoryIds) ? config.productCategoryIds : []).map((v: unknown) => String(v ?? "").trim()).filter((v: string) => /^\d{1,12}$/.test(v));
  return ids.length ? new Set(ids) : null;
}

const allowedIdsCache = new Map<string, { at: number; ids: Set<string>; failed: boolean }>();

/**
 * The ids of the products in the allowed categories, as the store answers
 * ?category=<id>, in its default language, in Hebrew and in English (on a
 * WPML store each language has its own ids).
 * Ten minutes per store; a read that failed is retried after one, and until
 * then nothing is allowed (closed, never every product).
 */
async function allowedProductIds(auth: string, base: string, cats: Set<string>): Promise<Set<string>> {
  // Every language a read may use (a Hebrew ask reads lang=he); one answer on a store without WPML.
  const langs: Array<string | null> = [null, "he", "en"];
  const key = `${base}|${[...cats].sort().join(",")}|${langs.join(",")}`;
  const hit = allowedIdsCache.get(key);
  if (hit && Date.now() - hit.at < (hit.failed ? 60_000 : 10 * 60_000)) return hit.ids;
  const ids = new Set<string>();
  let failed = false;
  await Promise.all([...cats].flatMap((cat) => langs.map(async (lang) => {
    for (let page = 1; page <= 3; page++) {
      const p = new URLSearchParams({ category: cat, status: "publish", per_page: "100", page: String(page), _fields: "id" });
      if (lang) p.set("lang", lang);
      const l: any = await wooRequest(auth, "GET", `${base}/products?${p}`).catch(() => { failed = true; return []; });
      for (const x of Array.isArray(l) ? l : []) if (/^\d{1,12}$/.test(String(x?.id ?? ""))) ids.add(String(x.id));
      if (!Array.isArray(l) || l.length < 100) break;
    }
  })));
  allowedIdsCache.set(key, { at: Date.now(), ids, failed });
  return ids;
}

/**
 * The language to read products in, only for a connection that declares one
 * (config.storeLanguage, a WPML / Polylang store): the conversation's
 * (args.lang, which the bot sets), else that one. Any other store: null, its
 * requests exactly as before. "he" or "en" only.
 */
export function productLanguage(args: any, config: any): "he" | "en" | null {
  const ok = (v: unknown) => { const x = String(v ?? "").trim().toLowerCase(); return x === "he" || x === "en" ? x : null; };
  const store = ok(config?.storeLanguage);
  if (!store) return null;
  return ok(args?.lang) ?? store;
}

/**
 * Brand and kind words that a Hebrew ask spells in Hebrew and a store writes in
 * Latin ("ורטואו" vs "vertuo plus", Smoovee 2026-11-08), stems on both sides.
 */
const DESCRIPTION_SYNONYMS: Record<string, string[]> = {
  "תמי": ["tami"], tami: ["תמי"], "רטואו": ["vertuo"], vertuo: ["רטואו"],
  "נספרסו": ["nespresso"], nespresso: ["נספרסו"], "נינג": ["ninja"], ninja: ["נינג"],
  "לוואצ": ["lavazza"], lavazza: ["לוואצ"], "קנווד": ["kenwood"], kenwood: ["קנווד"],
  "דלונגי": ["delonghi", "longhi"], delonghi: ["דלונגי"], "משטח": ["surface"], surface: ["משטח"],
  "מכונ": ["machine"], machine: ["מכונ"], "קפה": ["coffee"], coffee: ["קפה"],
};
const DESCRIPTION_STOP = new Set(["the", "and", "for", "with", "a", "an", "in", "of", "to", "model", "fits", "suitable", "דגמ", "דגם", "מתאימ", "מתאים", "תואמ", "תואם"]);

function decodeEntities(t: string): string {
  return t.replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c === 8217 || c === 8216 || c === 8221 || c === 8220 || c === 8243 ? "" : String.fromCharCode(c); })
    .replace(/&amp;/g, "&").replace(/&quot;/g, "").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ");
}

/**
 * A text's words for a description match, each with the forms it can stand
 * for: Hebrew stems, also without a one-letter prefix ("לתמי" is "תמי",
 * "למכונת" is "מכונ"); Latin stems; digits kept as words ("4" in "תמי 4").
 */
export function descriptionTokens(text: unknown): string[][] {
  const t = decodeEntities(String(text ?? "").replace(/<[^>]*>/g, " ")).toLowerCase().replace(/['"׳״]/g, "");
  const out: string[][] = [];
  for (const w of t.split(/[^a-z0-9א-ת]+/).filter(Boolean)) {
    if (DESCRIPTION_STOP.has(w)) continue;
    let forms: string[];
    if (/^[0-9]+$/.test(w)) forms = [w];
    else if (/[א-ת]/.test(w)) {
      if (w.length < 2 || HEBREW_STOP.has(hebrewStem(w))) continue;
      forms = [hebrewStem(w)];
      if (w.length > 3 && /^[לבמשכ]/.test(w)) forms.push(hebrewStem(w.slice(1)));
    } else {
      if (w.length < 2) continue;
      forms = [w.length >= 3 ? categoryStem(w) : w];
    }
    forms = forms.filter((f) => !DESCRIPTION_STOP.has(f));
    if (!forms.length) continue;
    out.push(Array.from(new Set([...forms, ...forms.flatMap((f) => DESCRIPTION_SYNONYMS[f] ?? [])])));
  }
  return out;
}

const catalogCache = new Map<string, { at: number; list: any[] | null }>();

/**
 * The store's whole published catalogue, at most two pages of 100, ten
 * minutes per store and language; null when it is bigger (a full second page).
 * A Hebrew ask reads lang=he: on a WPML / Polylang store that is the Hebrew
 * catalogue (its own ids, which the cards then use); a store without them
 * ignores the parameter and answers its one catalogue.
 */
async function wholeCatalog(auth: string, base: string, lang: string | null): Promise<any[] | null> {
  const key = `${base}|${lang ?? ""}`;
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
  const page = async (n: number) => {
    const p = new URLSearchParams({ per_page: "100", page: String(n), status: "publish" });
    if (lang) p.set("lang", lang);
    const l: any = await wooRequest(auth, "GET", `${base}/products?${p}`);
    return Array.isArray(l) ? l : [];
  };
  let list: any[] | null = await page(1);
  if (list.length >= 100) {
    const second = await page(2);
    list = second.length >= 100 ? null : [...list, ...second];
  }
  catalogCache.set(key, { at: Date.now(), list });
  return list;
}

/**
 * Smoovee (2026-11-08, cmw7p00cq): "דגם לתמי 4" found nothing, because what a
 * product fits is only in its short description ("מתאים ל: תמי 4 באבלס"), and
 * the store's own search reads neither. When every other route found nothing:
 * the query's words against each product's name, short description and
 * description. The most words matched wins; a word most of the catalogue holds
 * ("משטח" on a store of surfaces) never counts alone, nor does a number; name
 * or short description over description; in stock first. Only the top score:
 * a product that fits "תמי 3" is not offered for "תמי 4".
 */
async function descriptionSearch(
  auth: string, base: string, params: URLSearchParams, query: string, per: number, visible: (l: any) => any,
): Promise<any[]> {
  const words = descriptionTokens(query);
  if (!words.length) return [];
  // The store's language when the connection names one (lang in params), else the ask's.
  const lang = params.get("lang") || (/[א-ת]/.test(query) ? "he" : null);
  const all = await wholeCatalog(auth, base, lang).catch(() => null);
  if (!all) return [];
  const minP = Number(params.get("min_price") ?? NaN), maxP = Number(params.get("max_price") ?? NaN);
  const pool: any[] = (visible(all) as any[]).filter((p: any) =>
    (p?.status ?? "publish") === "publish"
    && (params.get("stock_status") !== "instock" || p?.stock_status !== "outofstock")
    && (!Number.isFinite(minP) || Number(p?.price) >= minP)
    && (!Number.isFinite(maxP) || Number(p?.price) <= maxP));
  if (!pool.length) return [];
  const flat = (t: unknown) => new Set(descriptionTokens(t).flat());
  const docs = pool.map((p) => ({ p, strong: flat(`${p?.name ?? ""} ${p?.short_description ?? ""}`), weak: flat(p?.description ?? "") }));
  const has = (d: { strong: Set<string>; weak: Set<string> }, w: string[]) => w.some((f) => d.strong.has(f)) ? 2 : w.some((f) => d.weak.has(f)) ? 1 : 0;
  // A word most of the catalogue holds names nothing in particular.
  const generic = words.map((w) => /^[0-9]+$/.test(w[0]) || docs.filter((d) => has(d, w)).length > docs.length / 2);
  if (generic.every(Boolean)) return [];
  const scored = docs.map((d) => {
    const m = words.map((w) => has(d, w));
    return { p: d.p, n: m.filter(Boolean).length, strong: m.filter((x) => x === 2).length, specific: m.some((x, i) => x && !generic[i]) };
  }).filter((x) => x.specific);
  if (!scored.length) return [];
  const top = Math.max(...scored.map((x) => x.n));
  // Marked: a match in the copy, not the title ("plate" is the spec label
  // "Plate: Perspex"), which the bot's turn may retry in the customer's words.
  const out = scored.filter((x) => x.n === top).sort((a, b) => b.strong - a.strong).map((x) => ({ ...x.p, matched_in: "description" }));
  return inStockFirst(out).slice(0, per);
}

/**
 * A Hebrew product ask, deterministic (see list_products). Logs which route
 * found it: [woo-search] hit=category:<id> | title | variant:<word> | none.
 */
async function hebrewProductSearch(
  auth: string, base: string, params: URLSearchParams, query: string, per: number, visible: (l: any) => any,
): Promise<any[]> {
  const get = async (p: URLSearchParams) => { const l = visible(await wooRequest(auth, "GET", `${base}/products?${p}`)); return Array.isArray(l) ? l : []; };
  const words = searchWords(query).filter((w) => !HEBREW_STOP.has(hebrewStem(w)));
  const log = (hit: string, n: number) => console.log(`[woo-search] query=${JSON.stringify(query.slice(0, 60))} hit=${hit} results=${n}`);
  // "מה יש כרגע במלאי" names no product (Tehila, cmw11vyau / cmw1s1vit): the
  // title search for "במלאי" found one sold-out scarf by its description. A
  // general stock ask is a browse of what is in stock, newest first, one from
  // each kind in turn so it is not ten of the same.
  if (words.every((w) => STOCK_ASK.has(hebrewStem(w)))) {
    const browse = new URLSearchParams(params);
    browse.delete("search");
    browse.set("stock_status", "instock");
    browse.set("orderby", "date");
    // An allow-list of categories filters what comes back: read a whole page.
    browse.set("per_page", String(wooStoreHasAllowList(base) ? 100 : Math.max(per * 3, 30)));
    const all = await get(browse);
    const kindOf = (p: any) => String((p?.categories ?? []).map((c: any) => c?.name).find((n: any) => n && !/uncategori[sz]ed|new in|NEW|ש"ח|ש&quot;ח|\d/.test(String(n))) ?? "");
    const groups = new Map<string, any[]>();
    for (const p of all) { const k = kindOf(p); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(p); }
    const out: any[] = [];
    for (let i = 0; out.length < all.length; i++) for (const g of groups.values()) if (g[i]) out.push(g[i]);
    log("browse:instock", out.length);
    return out.slice(0, per);
  }
  const cat = await categoryForQuery(auth, base, query, params.get("lang"));
  const catStems = new Set(cat ? queryStems(cat.name) : []);
  // Words the category does not account for: a name, a colour, a print.
  // A stock word ("אילו מטפחות יש במלאי") is a filter, never a word to search.
  const wantsStock = words.some((w) => STOCK_ASK.has(hebrewStem(w)));
  const rest = words.filter((w) => !STOCK_ASK.has(hebrewStem(w)) && !queryStems(w).some((s) => catStems.has(s)));
  const byCat = new URLSearchParams(params);
  byCat.delete("search");
  if (cat) { byCat.set("category", cat.id); byCat.set("per_page", String(Math.max(per, 30))); }
  if (wantsStock) byCat.set("stock_status", "instock");
  // The store's search also reads copy (Smoovee, lang=he: "דגם" is in a juicer's
  // "בראון דגם SJ3100BK"): a title hit is one whose name holds the word.
  const named_ = (w: string) => (p: any) => nameHolds(p, w);
  const restSearch = async (w: string) => { const p = new URLSearchParams(params); p.set("search", w); return (await get(p)).filter(named_(w)); };
  const [inCat, whole, ...perWord] = await Promise.all([
    cat ? get(byCat) : Promise.resolve([] as any[]),
    get(params).then((l) => l.filter((p: any) => words.some((w) => nameHolds(p, w)))),
    ...(words.length > 1 ? rest.slice(0, 2).map(restSearch) : []),
  ]);
  const named = [...perWord.flat(), ...(wantsStock && !rest.length ? [] : whole)].filter((p: any) => !wantsStock || p?.stock_status !== "outofstock");
  if (inCat.length) {
    const catIds = new Set(inCat.map((p: any) => String(p?.id)));
    // A product the words name AND in the category first ("מטפחת אנה"), then the category, then other title hits.
    const both = named.filter((p: any) => catIds.has(String(p?.id)));
    const seen = new Set<string>();
    const out = [...both, ...inStockFirst(inCat), ...named].filter((p: any) => !seen.has(String(p?.id)) && seen.add(String(p?.id)));
    log(`category:${cat!.id}`, out.length);
    return out.slice(0, per);
  }
  if (named.length) {
    const seen = new Set<string>();
    const out = named.filter((p: any) => !seen.has(String(p?.id)) && seen.add(String(p?.id)));
    log("title", out.length);
    return inStockFirst(out).slice(0, per);
  }
  // The other forms of each Hebrew word, in parallel; the first that finds anything.
  const variants = words.filter((w) => /[א-ת]/.test(w)).flatMap(hebrewVariants).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  const found = await Promise.all(variants.map(restSearch));
  const i = found.findIndex((l) => l.length);
  if (i >= 0) { log(`variant:${variants[i]}`, found[i].length); return inStockFirst(found[i]).slice(0, per); }
  // What a product fits is in its description (Smoovee: "מתאים ל: תמי 4").
  const described = await descriptionSearch(auth, base, params, query, per, visible);
  if (described.length) { log("description", described.length); return described; }
  log("none", 0);
  return [];
}

const VALIDATE_TIMEOUT_MS = 10_000;

/** The words worth searching alone, longest first ("black tank top" -> tank, black, top). */
export function searchWords(query: unknown): string[] {
  const STOP = new Set(["the", "and", "for", "with", "a", "an", "in", "of", "size", "color", "colour"]);
  const words = String(query ?? "").toLowerCase().split(/[^a-z0-9\u0590-\u05ff]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return Array.from(new Set(words)).sort((a, b) => b.length - a.length);
}

/** "hoodies" -> "hoodie", "dresses" -> "dress", "chinos" -> "chino"; anything else unchanged. */
export function singular(word: string): string {
  if (/(ss|sh|ch|x)es$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

/**
 * The colour and size words of a product query, apart from what to search for
 * (2026-10-26: "white" found nothing though the Oxford shirt comes in white).
 * Woo's search reads titles and copy, never a variation's attributes, and our
 * title filter then drops whatever the copy matched. So these words are not
 * searched: they are matched against each product's own options instead.
 */
const COLOUR_WORDS = new Set([
  "white", "black", "grey", "gray", "charcoal", "navy", "blue", "sky", "beige", "sand", "oat",
  "brown", "camel", "chocolate", "green", "olive", "sage", "red", "burgundy", "pink", "rose",
  "cream", "ecru", "ivory", "natural", "khaki", "yellow", "orange", "purple", "lilac", "denim",
]);
const SIZE_WORD = /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl)$/;

export function attributeWords(query: unknown): { rest: string; colours: string[]; sizes: string[] } {
  const tokens = String(query ?? "").toLowerCase().split(/[^a-z0-9\u0590-\u05ff-]+/).filter(Boolean);
  const colours: string[] = [];
  const sizes: string[] = [];
  const rest: string[] = [];
  for (const t of tokens) {
    // "off-white" is its own option; a bare "off" is not a word to search.
    if (t === "off-white" || t === "offwhite") colours.push("off-white");
    else if (COLOUR_WORDS.has(t)) colours.push(t);
    else if (SIZE_WORD.test(t)) sizes.push(t);
    else if (t !== "off" && t !== "size" && t !== "color" && t !== "colour" && t !== "in") rest.push(t);
  }
  return { rest: rest.join(" "), colours, sizes };
}

/**
 * Does a product come in these? A colour is in its options (any attribute) or
 * its title ("White Linen Shirt"); a size is an exact option. A product that
 * names no options at all cannot be ruled in by an option it does not list.
 */
export function offersAttributes(product: any, colours: string[], sizes: string[]): boolean {
  const options: string[] = (Array.isArray(product?.attributes) ? product.attributes : [])
    .flatMap((a: any) => (Array.isArray(a?.options) ? a.options : a?.option != null ? [a.option] : []))
    .map((o: any) => String(o).toLowerCase().trim());
  const title = String(product?.name ?? "").toLowerCase();
  // A hyphen joins a word: "white" is not "Off-White", which is its own colour.
  const word = (hay: string, w: string) => new RegExp(`(^|[^a-z-])${w.replace(/[^a-z-]/g, "")}($|[^a-z-])`).test(hay);
  const colourOk = colours.every((c) => options.some((o) => word(o, c)) || word(title, c));
  const sizeOk = sizes.every((z) => options.some((o) => o === z));
  return colourOk && sizeOk;
}

/** Products whose TITLE carries a query word, most words first; the rest are noise from a body match. */
export function rankByTitleWords(products: any[], words: string[]): any[] {
  // A substring: "Overshirt" is a shirt. Longer words weigh more, so "oversized
  // tee" ranks Oversized Cotton T-Shirt over Boxy Tee (eval e10 X7).
  // But a Sweatshirt is not a shirt (urban-e32 U5: "Shirts" came back as hoodies).
  const nameFor = (p: any, w: string) => {
    const name = String(p?.name ?? "").toLowerCase();
    return /^shirts?$/i.test(w) ? name.replace(/sweatshirts?/g, "") : name;
  };
  const hits = (p: any) => words.filter((w) => nameFor(p, w).includes(w.toLowerCase())).reduce((n, w) => n + w.length, 0);
  return products.map((p) => ({ p, n: hits(p) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.p);
}

/**
 * The store address, normalised: scheme + host (+ port) + a sub-directory
 * install path, no query, no fragment, no credentials. https only, except
 * http outside production (a local dev store). Returns null when unusable.
 */
export function normalizeStoreUrl(raw: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const allowHttp = env.NODE_ENV !== "production";
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) return null;
  if (u.username || u.password) return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Prove the keys work against THIS store before calling the connection
 * CONNECTED. system_status needs the manage_woocommerce capability the
 * read_write key of an administrator carries; orders is the fallback for a
 * shop manager. Either one answering 200 with JSON is proof.
 */
export async function validateWooKeys(
  storeUrl: string,
  consumerKey: string,
  consumerSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  let lastReason = "no_response";
  for (const path of ["/wp-json/wc/v3/system_status", "/wp-json/wc/v3/orders?per_page=1"]) {
    const url = `${storeUrl}${path}`;
    try {
      await assertPublicUrl(url);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
      const res = await fetchImpl(url, { headers: { Authorization: auth, Accept: "application/json" }, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        await res.json();
        return { ok: true };
      }
      lastReason = `http_${res.status}`;
    } catch (err: any) {
      lastReason = err?.name === "AbortError" ? "timeout" : String(err?.message || "fetch_failed").slice(0, 80);
    }
  }
  return { ok: false, reason: lastReason };
}


const WooCommerceAdapter: ProviderAdapter = {
  slug: "woocommerce",
  tools: () => TOOLS,

  /**
   * Prove a key pair works against THIS store before anything calls the
   * connection CONNECTED - the generic connect route and /test both run it.
   * A pasted key that is wrong, read-only for orders, or for another store
   * used to be stored as CONNECTED and fail on the first customer question.
   */
  async validate({ credentials, config }) {
    const consumerKey = credentials.consumerKey || credentials.consumer_key;
    const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
    if (!consumerKey || !consumerSecret) return { ok: false, error: "Enter both the consumer key and the consumer secret." };
    const storeUrl = normalizeStoreUrl(config.storeUrl || credentials.storeUrl || credentials.store_url);
    if (!storeUrl) return { ok: false, error: "Enter the store's https:// address." };
    const v = await validateWooKeys(storeUrl, String(consumerKey), String(consumerSecret));
    return v.ok
      ? { ok: true }
      : { ok: false, error: v.reason === "http_401" || v.reason === "http_403"
          ? "The store rejected these keys. Check that they are Read/Write keys for this store."
          : `The store could not be reached to check the keys (${v.reason}).` };
  },

  async execute({ toolName, args, credentials, config }) {
    const consumerKey = credentials.consumerKey || credentials.consumer_key;
    const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
    const storeUrl = String(config.storeUrl || credentials.storeUrl || credentials.store_url || "").replace(/\/$/, "");
    if (!consumerKey || !consumerSecret) throw new Error("no_woo_credentials");
    if (!storeUrl) throw new Error("no_store_url");
    const base = `${storeUrl}/wp-json/wc/v3`;
    const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
    // The connection's allowed categories (Smoovee: only "Shop Smoovee" can be
    // ordered) and the store's language (a WPML store answers its default
    // language otherwise: English names and prices for a Hebrew customer).
    const lang = productLanguage(args, config);
    const allowedCats = categoryAllowList(config);
    setStoreAllowedProducts(storeUrl, allowedCats ? await allowedProductIds(auth, base, allowedCats) : null);

    switch (toolName) {
      case "list_orders": {
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Number(args.per_page ?? 10))));
        if (args.status && args.status !== "any") params.set("status", String(args.status));
        if (args.email) params.set("search", String(args.email));
        // A period (WC REST takes ISO8601 after/before) and a page, for the
        // assistant's "orders this week".
        const iso = (v: unknown) => (typeof v === "string" && !isNaN(Date.parse(v)) ? new Date(v).toISOString().slice(0, 19) : null);
        const after = iso(args.after), before = iso(args.before);
        if (after) params.set("after", after);
        if (before) params.set("before", before);
        // The values are UTC; without this WooCommerce reads them in the site's zone.
        if (after || before) params.set("dates_are_gmt", "true");
        if (Number(args.page) > 1) params.set("page", String(Math.floor(Number(args.page))));
        return await wooRequest(auth, "GET", `${base}/orders?${params}`);
      }
      case "get_order":
        return await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id))}`);
      case "update_order_status": {
        const id = encodeURIComponent(String(args.order_id));
        const order = await wooRequest(auth, "PUT", `${base}/orders/${id}`, { status: String(args.status) });
        // The note is an order note the customer sees (POST /orders/:id/notes).
        // It was written into customer_note, which OVERWROTE the note the
        // customer left on their own order (2026-10-13).
        if (args.note) {
          const note = await wooRequest(auth, "POST", `${base}/orders/${id}/notes`, { note: String(args.note), customer_note: true });
          return { ...(order as Record<string, unknown>), added_note: note };
        }
        return order;
      }
      case "get_customer": {
        if (args.customer_id) {
          return await wooRequest(auth, "GET", `${base}/customers/${encodeURIComponent(String(args.customer_id))}`);
        }
        if (args.email) {
          const list: any = await wooRequest(auth, "GET", `${base}/customers?email=${encodeURIComponent(String(args.email))}`);
          return Array.isArray(list) ? (list[0] ?? null) : list;
        }
        throw new Error("customer_id_or_email_required");
      }
      case "search_customers": {
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Number(args.per_page ?? 10))));
        params.set("search", String(args.query));
        return await wooRequest(auth, "GET", `${base}/customers?${params}`);
      }
      case "list_products": {
        // Who it is for (dev 2026-10-27: "בשבילי לגבר" got the women's trench):
        // the store's own top-level Men / Women category, applied to what the
        // search finds. A store with no such category: the search as it is.
        const audience = args.audience === "men" || args.audience === "women" ? args.audience : null;
        if (audience) {
          const cat = await audienceCategory(auth, base, audience);
          const per = Math.min(100, Number(args.per_page ?? 10));
          const found: any = await WooCommerceAdapter.execute({
            toolName,
            args: { ...args, audience: undefined, per_page: Math.max(per, 50) },
            credentials,
            config,
          } as any);
          if (!cat || !Array.isArray(found)) return Array.isArray(found) ? found.slice(0, per) : found;
          return found.filter((p: any) => (p?.categories ?? []).some((c: any) => String(c?.id) === cat)).slice(0, per);
        }
        // The customer wrote Hebrew and the model searched in Latin (Tehila:
        // "מטפחה חגיגית" sent as "scarf", every scarf instead of the festive
        // ones). On a store whose catalogue is Hebrew, the customer's own words
        // run the Hebrew route alongside the model's query, and what they find
        // comes first, unless they found only copy and the model found more.
        // An English-title store (urban) keeps the model's translation as it is.
        const own = typeof args.customer_query === "string" ? args.customer_query.trim() : "";
        if (own && /[א-ת]/.test(own) && !/[א-ת]/.test(String(args.query ?? "")) && !args.include && !args.category) {
          const rest = { ...args, customer_query: undefined };
          if (await storeCatalogIsHebrew(auth, base, lang).catch(() => false)) {
            const per = Math.min(100, Number(args.per_page ?? 10));
            const [mine, theirs]: any[] = await Promise.all([
              WooCommerceAdapter.execute({ toolName, args: { ...rest, query: own, kind: undefined, rank: undefined }, credentials, config } as any).catch(() => []),
              WooCommerceAdapter.execute({ toolName, args: rest, credentials, config } as any),
            ]);
            const a = Array.isArray(mine) ? mine : [], b = Array.isArray(theirs) ? theirs : [];
            const copyOnly = (l: any[]) => l.length > 0 && l.every((p) => p?.matched_in === "description");
            const first = copyOnly(a) && b.length && !copyOnly(b) ? [b, a] : [a, b];
            const seen = new Set<string>();
            const merged = first.flat().filter((p: any) => !seen.has(String(p?.id)) && seen.add(String(p?.id)));
            console.log(`[woo-search] customer-words query=${JSON.stringify(own.slice(0, 60))} model=${JSON.stringify(String(args.query ?? "").slice(0, 40))} own=${a.length} model_results=${b.length} first=${first[0] === a ? "customer" : "model"}`);
            return Array.isArray(theirs) || a.length ? merged.slice(0, per) : theirs;
          }
          args = rest;
        }
        // A colour or a size: search the noun, then keep what comes in it.
        const wanted = attributeWords(args.query);
        // The inner call's query has no colour or size left, so it cannot recurse.
        if (wanted.colours.length || wanted.sizes.length) {
          const per = Math.min(100, Number(args.per_page ?? 10));
          const found: any = await WooCommerceAdapter.execute({
            toolName,
            // No noun ("white"): the catalogue's first 50, matched on options.
            args: { ...args, query: wanted.rest || undefined, per_page: wanted.rest ? Math.max(per, 20) : 50 },
            credentials,
            config,
          } as any);
          if (!Array.isArray(found)) return found;
          return found.filter((p: any) => offersAttributes(p, wanted.colours, wanted.sizes)).slice(0, per);
        }
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Number(args.per_page ?? 10))));
        if (args.query) params.set("search", String(args.query));
        // Only what the store itself shows: published, not hidden (W9).
        params.set("status", "publish");
        if (lang) params.set("lang", lang);
        const price = (v: unknown) => (typeof v === "number" || typeof v === "string") && Number.isFinite(Number(v)) && Number(v) >= 0 ? String(Number(v)) : null;
        if (price(args.price_min)) params.set("min_price", price(args.price_min)!);
        if (price(args.price_max)) params.set("max_price", price(args.price_max)!);
        if (args.in_stock === true) params.set("stock_status", "instock");
        // Internal callers only (the web chat's complementary products): not in
        // the model's schema. Numeric ids and a numeric category, nothing else.
        const ids = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter((x) => /^\d{1,12}$/.test(x)).slice(0, 100);
        if (ids(args.include).length) params.set("include", ids(args.include).join(","));
        if (ids(args.exclude).length) params.set("exclude", ids(args.exclude).join(","));
        if (/^\d{1,12}$/.test(String(args.category ?? ""))) params.set("category", String(args.category));
        // ...and only the connection's allowed categories, when it names some.
        const visible = (l: any) => (Array.isArray(l) ? l.filter((p: any) => p?.catalog_visibility !== "hidden" && wooProductAllowed(storeUrl, p)) : l);
        // Internal (the web chat, not in the model's schema): a broad kind the
        // customer named is the store's whole category, ranked by the kind's
        // own title word (urban replay 2026-10-28: "מעיל לגברים" searched
        // "Jacket", and the overcoat was ranked out). No such category: the
        // search as asked.
        if (typeof args.kind === "string" && args.kind.trim() && !params.has("category")) {
          const cat = await categoryForQuery(auth, base, args.kind, params.get("lang"));
          if (cat?.id) {
            const byKind = new URLSearchParams(params);
            byKind.delete("search");
            byKind.set("category", cat.id);
            byKind.set("per_page", "50");
            const all: any = visible(await wooRequest(auth, "GET", `${base}/products?${byKind}`));
            if (Array.isArray(all) && all.length) {
              const first = rankByTitleWords(all, Array.from(new Set(searchWords(args.rank ?? args.kind).map(singular))));
              return [...first, ...all.filter((p: any) => !first.includes(p))].slice(0, Math.min(100, Number(args.per_page ?? 10)));
            }
          }
        }
        // A Hebrew ask (Tehila 2026-11-04): her titles are names ("אנה",
        // "פרינט- קרואלה"), so "מטפחה חגיגית" or "הקולקציה החדשה" is found
        // only by her category. The category the words name, its products in
        // stock first; a word the category does not account for ("מטפחת אנה")
        // is searched in titles too, in parallel, and those come first. An
        // empty result retries the words' other forms (מטפחה -> מטפחת, מטפחות).
        if (/[֐-׿]/.test(String(args.query ?? "")) && !params.has("category") && !params.has("include")) {
          return await hebrewProductSearch(auth, base, params, String(args.query), Math.min(100, Number(args.per_page ?? 10)), visible);
        }
        // An allow-list filters after the read: read a whole page, then cut (the
        // store's newest ten may all be outside it, Smoovee's Woody line).
        const perAsked = Number(params.get("per_page") ?? 10);
        const read = new URLSearchParams(params);
        if (wooStoreHasAllowList(storeUrl)) read.set("per_page", "100");
        const listed: any = visible(await wooRequest(auth, "GET", `${base}/products?${read}`));
        const list: any = Array.isArray(listed) ? listed.slice(0, perAsked) : listed;
        // Woo matches the whole phrase as a substring of the title: "black tank
        // top" misses "Organic Rib Tank" (eval H02), and a plural or a category
        // name misses everything: "hoodies" vs "Cropped Hoodie", "chinos" vs
        // "Chino Pants", "Jackets & Coats" (eval e5 S1). An empty search is
        // retried: the store's category of that name, then each word in its
        // singular form. At most 4 more requests.
        const words = searchWords(args.query);
        // Title words decide only for a query in the store's language (English
        // titles): a Hebrew word is never in a title (eval e8 U2).
        const latin = /[a-z]/i.test(String(args.query ?? "")) && !/[\u0590-\u05FF]/.test(String(args.query ?? ""));
        // Woo also matches descriptions: "Shirts" returned only Cropped Hoodie
        // (its copy says "sweatshirt"). A result with no title carrying a query
        // word is treated as empty, so the retries below run.
        const titleHits = Array.isArray(list) && list.length && words.length && latin
          ? rankByTitleWords(list, Array.from(new Set(words.map(singular))))
          : null;
        if (titleHits && titleHits.length) return titleHits;
        if (Array.isArray(list) && (list.length === 0 || (titleHits && !titleHits.length)) && words.length) {
          const seen = new Map<string, any>();
          const add = (l: any) => { if (Array.isArray(l)) for (const p of l) if (!seen.has(String(p?.id))) seen.set(String(p?.id), p); };
          const cat = await categoryForQuery(auth, base, args.query, params.get("lang"));
          if (cat?.id) {
            const byCat = new URLSearchParams(params);
            byCat.delete("search");
            byCat.set("category", String(cat.id));
            add(visible(await wooRequest(auth, "GET", `${base}/products?${byCat}`)));
            // The category's products, those whose title holds a query word first ("cotton shirts").
            if (seen.size) {
              const all = Array.from(seen.values());
              const first = rankByTitleWords(all, Array.from(new Set(words.map(singular))));
              return [...first, ...all.filter((p) => !first.includes(p))];
            }
          }
          const stems = Array.from(new Set(words.map(singular))).slice(0, 3);
          for (const w of stems) {
            params.set("search", w);
            add(visible(await wooRequest(auth, "GET", `${base}/products?${params}`)));
          }
          const ranked = rankByTitleWords(Array.from(seen.values()), stems);
          if (ranked.length) return ranked;
          // "Tami 4": what a product fits is in its description only (Smoovee 2026-11-08).
          params.delete("search");
          const described = await descriptionSearch(auth, base, params, String(args.query), Math.min(100, Number(args.per_page ?? 10)), visible);
          console.log(`[woo-search] query=${JSON.stringify(String(args.query).slice(0, 60))} hit=${described.length ? "description" : "none"} results=${described.length}`);
          return described;
        }
        return list;
      }
      case "create_coupon": {
        const body: any = {
          code: String(args.code),
          discount_type: args.discount_type === "fixed_cart" ? "fixed_cart" : "percent",
          amount: String(args.amount),
          usage_limit: Number(args.usage_limit ?? 1),
          individual_use: true,
        };
        if (args.expires_iso) body.date_expires = String(args.expires_iso);
        // A store credit for an order (2026-10-14: "credit575" was a ₪549
        // code anyone could redeem): usable only by that order's customer.
        // The address is the order's own billing email, read here, never one
        // the model passes; no billing email, no credit.
        if (args.order_id != null && String(args.order_id).trim()) {
          const order: any = await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id).trim())}`);
          const email = typeof order?.billing?.email === "string" ? order.billing.email.trim().toLowerCase() : "";
          if (!email.includes("@")) {
            throw new Error("credit_needs_billing_email: this order has no billing email, so a store credit could not be limited to its customer. Offer a refund instead, or hand over to a person.");
          }
          body.email_restrictions = [email];
          body.description = `store credit for order #${order.number ?? order.id}`;
        }
        return await wooRequest(auth, "POST", `${base}/coupons`, body);
      }
      case "list_order_notes":
        return await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id))}/notes`);
      case "add_order_note":
        return await wooRequest(auth, "POST", `${base}/orders/${encodeURIComponent(String(args.order_id))}/notes`, {
          note: String(args.note),
          customer_note: args.customer_visible === true,
        });
      case "list_refunds":
        return await wooRequest(auth, "GET", `${base}/orders/${encodeURIComponent(String(args.order_id))}/refunds`);
      case "create_refund": {
        const amount = String(args.amount ?? "").trim();
        if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error("invalid_refund_amount");
        // api_refund: through the payment gateway, so money actually moves
        // (false would only record a manual refund in WooCommerce).
        return await wooRequest(auth, "POST", `${base}/orders/${encodeURIComponent(String(args.order_id))}/refunds`, {
          amount,
          reason: args.reason ? String(args.reason) : undefined,
          api_refund: true,
        });
      }
      case "cancel_order": {
        const id = encodeURIComponent(String(args.order_id));
        const current: any = await wooRequest(auth, "GET", `${base}/orders/${id}`);
        if (current && ["completed", "cancelled", "refunded"].includes(String(current.status))) {
          throw new Error(`order_not_cancellable:${current.status}`);
        }
        const order = await wooRequest(auth, "PUT", `${base}/orders/${id}`, { status: "cancelled" });
        if (args.note) {
          await wooRequest(auth, "POST", `${base}/orders/${id}/notes`, { note: String(args.note), customer_note: true });
        }
        return order;
      }
      case "update_shipping_address": {
        const id = encodeURIComponent(String(args.order_id));
        const current: any = await wooRequest(auth, "GET", `${base}/orders/${id}`);
        if (current && ["completed", "cancelled", "refunded"].includes(String(current.status))) {
          throw new Error(`order_already_${current.status}`);
        }
        const shipping: Record<string, string> = {};
        for (const k of ["first_name", "last_name", "address_1", "address_2", "city", "postcode", "country", "state", "phone"]) {
          if (args[k] != null && String(args[k]).trim()) shipping[k] = String(args[k]).trim();
        }
        return await wooRequest(auth, "PUT", `${base}/orders/${id}`, { shipping });
      }
      case "update_customer": {
        const body: any = {};
        if (args.first_name) body.first_name = String(args.first_name);
        if (args.last_name) body.last_name = String(args.last_name);
        if (args.email) body.email = String(args.email);
        if (args.phone) body.billing = { phone: String(args.phone) };
        if (!Object.keys(body).length) throw new Error("nothing_to_update");
        return await wooRequest(auth, "PUT", `${base}/customers/${encodeURIComponent(String(args.customer_id))}`, body);
      }
      case "create_customer": {
        const body: any = { email: String(args.email) };
        if (args.first_name) body.first_name = String(args.first_name);
        if (args.last_name) body.last_name = String(args.last_name);
        if (args.phone) body.billing = { phone: String(args.phone), email: String(args.email) };
        return await wooRequest(auth, "POST", `${base}/customers`, body);
      }
      case "get_product": {
        // Internal callers may look a product up by its slug (a page's URL
        // names it, often in Hebrew); the model's schema still takes the id.
        if (!args.product_id && typeof args.slug === "string" && args.slug.trim()) {
          const params = new URLSearchParams({ slug: args.slug.trim(), status: "publish", per_page: "1" });
          if (lang) params.set("lang", lang);
          const list: any = await wooRequest(auth, "GET", `${base}/products?${params}`);
          if (!Array.isArray(list) || !list[0] || !wooProductAllowed(storeUrl, list[0])) throw new Error("woocommerce_404: product_not_found");
          return list[0];
        }
        const one: any = await wooRequest(auth, "GET", `${base}/products/${encodeURIComponent(String(args.product_id))}${lang ? `?lang=${lang}` : ""}`);
        // Outside the allowed categories is not a product this store offers.
        if (!wooProductAllowed(storeUrl, one)) throw new Error("woocommerce_404: product_not_found");
        return one;
      }
      case "list_product_categories": {
        // Internal callers only (the web chat's add-ons): not in the model's tools.
        const list: any = await wooRequest(auth, "GET", `${base}/products/categories?per_page=100&hide_empty=true`);
        return Array.isArray(list) ? list.map((c: any) => ({ id: c?.id, name: c?.name, parent: c?.parent, count: c?.count })) : [];
      }
      case "list_product_variations": {
        const per = Math.min(100, Number(args.per_page ?? 50));
        return await wooRequest(auth, "GET", `${base}/products/${encodeURIComponent(String(args.product_id))}/variations?per_page=${per}`);
      }
      case "list_coupons": {
        const params = new URLSearchParams();
        params.set("per_page", String(Math.min(100, Math.max(1, Number(args.per_page ?? 20) || 20))));
        if (Number(args.page) > 1) params.set("page", String(Math.floor(Number(args.page))));
        // Only these ids (the widget's chosen promotions, W9): numeric only.
        const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map((v) => String(v ?? "").trim()).filter((v) => /^\d{1,12}$/.test(v)) : [];
        if (Array.isArray(args.ids)) {
          if (!ids.length) return [];
          params.set("include", ids.join(","));
        }
        return await wooRequest(auth, "GET", `${base}/coupons?${params}`);
      }
      case "get_coupon": {
        const list: any = await wooRequest(auth, "GET", `${base}/coupons?code=${encodeURIComponent(String(args.code))}`);
        const c = Array.isArray(list) ? list[0] : null;
        if (!c) return { code: String(args.code), exists: false, valid: false, reason: "not_found" };
        const expired = !!c.date_expires_gmt && Date.parse(`${c.date_expires_gmt}Z`) < Date.now();
        const usedUp = c.usage_limit != null && Number(c.usage_count ?? 0) >= Number(c.usage_limit);
        const active = (c.status ?? "publish") === "publish";
        return {
          code: c.code, exists: true,
          valid: active && !expired && !usedUp,
          reason: !active ? "disabled" : expired ? "expired" : usedUp ? "used_up" : null,
          discount_type: c.discount_type, amount: c.amount,
          expires: c.date_expires ?? null, usage_count: c.usage_count ?? 0, usage_limit: c.usage_limit ?? null,
          minimum_amount: c.minimum_amount ?? null,
        };
      }
      case "disable_coupon": {
        let id = args.coupon_id ? String(args.coupon_id) : null;
        if (!id && args.code) {
          const list: any = await wooRequest(auth, "GET", `${base}/coupons?code=${encodeURIComponent(String(args.code))}`);
          id = Array.isArray(list) && list[0] ? String(list[0].id) : null;
        }
        if (!id) throw new Error("coupon_not_found");
        // Draft = cannot be applied, and can be published again (not deleted).
        return await wooRequest(auth, "PUT", `${base}/coupons/${encodeURIComponent(id)}`, { status: "draft" });
      }
      case "list_customer_orders": {
        const per = Math.min(100, Math.max(1, Number(args.per_page ?? 10) || 10));
        const query = (extra: Record<string, string>) => {
          const params = new URLSearchParams({ per_page: String(per), orderby: "date", order: "desc", ...extra });
          return wooRequest(auth, "GET", `${base}/orders?${params}`) as Promise<any>;
        };
        if (args.customer_id) return await query({ customer: String(args.customer_id) });
        // A guest checkout has no customer: its phone and email live only on
        // the order. Woo's order search reads billing/shipping, so search
        // those, in every way a phone is commonly stored, and merge.
        const terms = [...orderPhoneSearchTerms(args.phone), ...(args.email ? [String(args.email).trim()] : [])];
        if (!terms.length) throw new Error("phone_email_or_customer_id_required");
        const found = new Map<string, any>();
        for (const term of terms) {
          const rows = await query({ search: term });
          for (const o of Array.isArray(rows) ? rows : []) if (o?.id != null) found.set(String(o.id), o);
        }
        return [...found.values()]
          .sort((a, b) => String(b?.date_created_gmt ?? "").localeCompare(String(a?.date_created_gmt ?? "")))
          .slice(0, per);
      }
      case "get_shipment_tracking": {
        // The extension serves its own namespace, not wc/v3: the wc/v3 path
        // answered 404 on a store that HAS the extension, so the tool said
        // "no tracking" everywhere.
        try {
          const out = await wooRequest(auth, "GET", `${storeUrl}/wp-json/${SHIPMENT_TRACKING_NAMESPACE}/orders/${encodeURIComponent(String(args.order_id))}/shipment-trackings`);
          void recordShipmentTracking(storeUrl, true);
          return out;
        } catch (err: any) {
          // No such route = no Shipment Tracking extension on the store: say so,
          // do not fail, and stop offering the tool. A 404 for an unknown order
          // is a different answer and is thrown as it is.
          if (/woocommerce_404/.test(String(err?.message)) && /rest_no_route/.test(String(err?.message))) {
            void recordShipmentTracking(storeUrl, false);
            return { supported: false, reason: "The store does not have the WooCommerce Shipment Tracking extension, so no tracking is available." };
          }
          throw err;
        }
      }
      default:
        throw new Error(`unknown_woocommerce_tool:${toolName}`);
    }
  },
};

/**
 * The store's currency (ISO code), for pricing product cards and comparing a
 * budget. Internal only (not a tool the model can call): read once, cached on
 * the connection by the caller. Null when the store does not answer.
 */
export async function fetchWooStoreCurrency(credentials: Record<string, any>, config: Record<string, any>): Promise<string | null> {
  const consumerKey = credentials.consumerKey || credentials.consumer_key;
  const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
  const storeUrl = String(config.storeUrl || credentials.storeUrl || credentials.store_url || "").replace(/\/$/, "");
  if (!consumerKey || !consumerSecret || !storeUrl) return null;
  const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  try {
    const cur: any = await wooRequest(auth, "GET", `${storeUrl}/wp-json/wc/v3/data/currencies/current`);
    const code = typeof cur?.code === "string" ? cur.code.toUpperCase() : "";
    return /^[A-Z]{3}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** WOO_REQUEST_TIMEOUT_MS, default 20s. */
export function wooRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WOO_REQUEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/**
 * DEV ONLY: an artificial delay before every store request, to reproduce a slow
 * store end to end (2026-11-02). Read from the Redis key "debug:woo-delay-ms"
 * (set with an expiry, so it switches itself off); only on the dev stack.
 */
export async function debugStoreDelay(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // The dev stack only (NODE_ENV=development): never production, never tests.
  if (env.NODE_ENV !== "development") return 0;
  // Never a reason for a store request to fail or wait: no Redis, no delay.
  let ms = 0;
  try {
    ms = Number(await Promise.race([getRedis().get("debug:woo-delay-ms"), new Promise<null>((r) => setTimeout(() => r(null), 250))]));
  } catch { return 0; }
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const wait = Math.min(ms, 60_000);
  await new Promise((r) => setTimeout(r, wait));
  return wait;
}

/**
 * A replay seam for dev walk harnesses (2026-11-08): answers store requests
 * in-process from a recorded catalogue, so a real bot turn can run against a
 * store whose keys we do not hold. Set only by code in the same process (no
 * env, no route); unset in every service. No network call is made while set.
 */
let requestSeam: ((method: string, url: string, body?: unknown) => Promise<unknown>) | null = null;
export function setWooRequestSeam(fn: typeof requestSeam) { requestSeam = fn; }

async function wooRequest(authHeader: string, method: string, url: string, body?: unknown): Promise<unknown> {
  if (requestSeam) {
    const out = await requestSeam(method, url, body);
    if (method === "GET") rememberListed(url, out);
    return out;
  }
  // SSRF guard: storeUrl is free-form tenant config. Block private/metadata
  // targets at DNS resolution before dispatching.
  await assertPublicUrl(url);
  await debugStoreDelay();
  const startedAt = Date.now();
  const init: RequestInit = {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  // A store that does not answer must not hold a customer's turn (Tehila,
  // 2026-11-02: 12-24s per call, no cap). Sized above a slow-but-working store.
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(wooRequestTimeoutMs()) }).catch((err: any) => {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new Error("woocommerce_timeout: the store did not answer in time");
    throw err;
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`woocommerce_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  const out = await res.json();
  const ms = Date.now() - startedAt;
  // One line per store request: which kind, how long (her host is slow only at moments).
  if (ms > 3000) console.warn(`[woo-request] slow ${method} ${new URL(url).pathname.replace(/^.*\/wc\/v3/, "")} ${ms}ms`);
  if (method === "GET") rememberListed(url, out);
  return out;
}

registerAdapter(WooCommerceAdapter);
export default WooCommerceAdapter;
