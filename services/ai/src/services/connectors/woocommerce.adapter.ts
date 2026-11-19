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

import { AsyncLocalStorage } from "async_hooks";
import { assertPublicUrl, getRedis } from "@chatcenter/shared";
import { orderPhoneSearchTerms } from "../../lib/order-phone-search";
import { rememberListed, setStoreAllowedProducts, wooProductAllowed, wooStoreHasAllowList } from "./woo-listed-products";
export { recentlyListedWooProduct } from "./woo-listed-products";
export { orderPhoneSearchTerms };
import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";
import { SHIPMENT_TRACKING_NAMESPACE, recordShipmentTracking } from "./woo-shipment-tracking";
import { semanticProductSearch } from "../catalog-semantic.service";

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
        on_sale: { type: "boolean", description: "true = only products on sale (the customer asks what is on sale)." },
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


// ── Store read caches (prod replay 7, Tehila timing: the first search of a
// process took 13.98s, categories 4.8s then two catalogue pages 5.4s and 3.4s
// in series; warm runs 1.0-1.5s). Stale-while-revalidate: a fresh entry is
// served; a stale one is served AND refreshed in the background (one refresh
// per key at a time); only a missing or too-old one makes the caller wait.
const inflight = new Map<string, Promise<unknown>>();
export async function swrCached<T>(
  cache: Map<string, { at: number; value: T }>,
  key: string,
  freshMs: number,
  staleMs: number,
  load: () => Promise<T>,
  keep: (v: T) => boolean = () => true,
): Promise<T> {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  const refresh = (): Promise<T> => {
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load().then((v) => { if (keep(v)) cache.set(key, { at: Date.now(), value: v }); return v; }).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
  const kind = key.split("|")[0];
  if (hit && age < freshMs) { countCache(kind, "hit"); return hit.value; }
  if (hit && age < staleMs) { countCache(kind, "stale"); refresh().catch(() => {}); return hit.value; }
  countCache(kind, "miss");
  return refresh();
}
/** Cache hits, stale serves and misses by kind (cats, catalog), for the replay's summary. */
export const cacheCounts: Record<string, { hit: number; stale: number; miss: number }> = {};
function countCache(kind: string, what: "hit" | "stale" | "miss") {
  (cacheCounts[kind] ??= { hit: 0, stale: 0, miss: 0 })[what]++;
}
/** Categories change rarely: fresh 6h, served stale up to 24h. */
const CATEGORY_FRESH_MS = 6 * 60 * 60_000;
const CATEGORY_STALE_MS = 24 * 60 * 60_000;
/** The catalogue: fresh 10 min (prices and stock), served stale up to 6h while it refreshes. */
const CATALOG_FRESH_MS = 10 * 60_000;
const CATALOG_STALE_MS = 6 * 60 * 60_000;

const AUDIENCE_NAME: Record<"men" | "women", RegExp> = {
  men: /^(?:men|mens|men'?s|man|male|גברים|גבר)$/i,
  women: /^(?:women|womens|women'?s|woman|female|נשים|אישה)$/i,
};
const audienceCache = new Map<string, { at: number; ids: Record<string, string | null> }>();

/** The store's top-level category for men or women (its id), or null; cached ten minutes per store. */
async function audienceCategory(auth: string, base: string, audience: "men" | "women"): Promise<string | null> {
  const hit = audienceCache.get(base);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ids[audience] ?? null;
  // The same cached category list as every other category read.
  const list: any = (await storeCategories(auth, base))?.list ?? null;
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

const categoryCache = new Map<string, { at: number; value: any[] | null }>();

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
/** The store's non-empty categories, per store and language: fresh 6h, stale-while-revalidate up to 24h. */
async function storeCategories(auth: string, base: string, lang?: string | null): Promise<{ list: any[] } | null> {
  const key = `cats|${lang ? `${base}|${lang}` : base}`;
  const list = await swrCached(categoryCache, key, CATEGORY_FRESH_MS, CATEGORY_STALE_MS, async () => {
    const l: any = await wooRequest(auth, "GET", `${base}/products/categories?per_page=100&hide_empty=true${lang ? `&lang=${lang}` : ""}`).catch(() => null);
    return Array.isArray(l) ? l : null;
  }, (v) => Array.isArray(v));
  return Array.isArray(list) ? { list } : null;
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

/**
 * What a store of stands calls the product itself (Smoovee 2026-11-14: "מה
 * הגובה של המעמד?" searched "מעמד" and found nothing). Alone they browse the
 * range; beside other words they name nothing.
 */
const STAND_WORDS = new Set(["מעמד", "מעמדים", "סטנד", "בסיס", "משטח", "משטחים", "משטחי"].map((w) => hebrewStem(w)));

/**
 * A Hebrew query that names nothing in particular on a store of stands ("משטח",
 * "מעמד", "מוצרים"): the customer's own words go beside it (Smoovee prod
 * 2026-11-14 19:18: "סמובי אלכסה שחור" was searched as "משטח" and Ariel came back).
 */
export function genericStoreQuery(query: unknown): boolean {
  const words = searchWords(query).filter((w) => /[א-ת]/.test(w));
  return words.length > 0 && words.every((w) => STAND_WORDS.has(hebrewStem(w)) || STOCK_ASK.has(hebrewStem(w)) || HEBREW_STOP.has(hebrewStem(w)));
}

/** A product's text without its usage notes ("הערות שימוש: ..."), which say nothing of what it fits. */
function withoutUsageNotes(t: unknown): string {
  return String(t ?? "").split(/הערות\s*שימוש|הערות:|usage notes/i)[0];
}

/**
 * A product's own "מתאים ל: ..." list (Smoovee: "מתאים ל: מיקרוגל ארגז חול
 * לחתולים נינג'ה גריל XL"), short description first, without the notes after
 * it. Empty when it has none.
 */
export function fitListOf(p: any): string {
  for (const src of [p?.short_description, p?.description]) {
    const t = decodeEntities(String(src ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
    const m = /(?:מתאים|מתאימה|מתאימים)\s*ל\s*[:\-]?\s*(.+)/u.exec(t) ?? /\b(?:suitable for|fits)\s*:?\s*(.+)/i.exec(t);
    if (m) return m[1].split(/הערות|מידע נוסף|יתרונות המוצר|מפרט|\bnotes?:/u)[0].trim();
  }
  return "";
}

/** A fit-list word's forms: its description forms, and a Hebrew construct plural without its yod ("ברי מים", "מעבדי מזון"). */
function fitForms(text: unknown): Set<string> {
  const out = new Set<string>();
  for (const forms of descriptionTokens(text)) for (const f of forms) {
    out.add(f);
    if (/[א-ת]י$/.test(f) && f.length >= 3) out.add(f.slice(0, -1));
  }
  return out;
}

/** The customer's word against a list word: the same, or the start of it ("מיקרו" is "מיקרוגל"). */
function fitWordMatches(q: string, doc: Set<string>): boolean {
  if (doc.has(q)) return true;
  if (/^[0-9]+$/.test(q) || q.length < 4) return false;
  for (const t of doc) if (t.length > q.length && t.startsWith(q)) return true;
  return false;
}

/**
 * The products whose own "מתאים ל" list names what the customer named
 * (Smoovee 2026-11-15: "בר מים" found only a sold-out title, while Ariel, Adam
 * and Alexa list "ברי מים"; "מיקרו" found nothing, Asaf lists "מיקרוגל"). The
 * most words matched wins, a number never counts alone, a word most lists
 * hold counts for nothing; in stock first.
 */
export function fitListMatches(list: any[], query: string, per: number): any[] {
  // A three-letter word keeps its one-letter prefix in descriptionTokens ("לבר");
  // here it also stands without it ("בר", the list's "ברי מים").
  const words = descriptionTokens(query)
    .filter((forms) => !forms.some((f) => STAND_WORDS.has(f) || STOCK_ASK.has(f)))
    .map((forms) => (forms.length === 1 && /^[לבמשכוה][א-ת]{2}$/.test(forms[0]) ? [forms[0], forms[0].slice(1)] : forms));
  if (!words.length) return [];
  const docs = list.map((p) => ({ p, d: fitForms(fitListOf(p)) })).filter((x) => x.d.size);
  if (!docs.length) return [];
  const hit = (d: Set<string>, forms: string[]) => forms.some((f) => fitWordMatches(f, d));
  const generic = words.map((forms) => /^[0-9]+$/.test(forms[0]) || docs.filter((x) => hit(x.d, forms)).length > docs.length / 2);
  if (generic.every(Boolean)) return [];
  const scored = docs.map((x) => {
    const m = words.map((forms) => hit(x.d, forms));
    return { p: x.p, n: m.filter(Boolean).length, specific: m.some((v, i) => v && !generic[i]) };
  }).filter((x) => x.specific);
  if (!scored.length) return [];
  const top = Math.max(...scored.map((x) => x.n));
  return inStockFirst(scored.filter((x) => x.n === top).map((x) => ({ ...x.p, matched_in: "fits_list" }))).slice(0, per);
}

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
  if (hit && Date.now() - hit.at < (hit.failed ? 60_000 : 10 * 60_000)) { countCache("allowed", "hit"); return hit.ids; }
  countCache("allowed", hit && !hit.failed && Date.now() - hit.at < CATALOG_STALE_MS ? "stale" : "miss");
  // A good list past its ten minutes is served while it refreshes (up to 6h); a failed one is retried now.
  if (hit && !hit.failed && Date.now() - hit.at < CATALOG_STALE_MS) {
    if (!inflight.has(`allowed|${key}`)) {
      const p = loadAllowedIds(auth, base, cats, langs, key).finally(() => inflight.delete(`allowed|${key}`));
      inflight.set(`allowed|${key}`, p);
      p.catch(() => {});
    }
    return hit.ids;
  }
  return loadAllowedIds(auth, base, cats, langs, key);
}

async function loadAllowedIds(auth: string, base: string, cats: Set<string>, langs: Array<string | null>, key: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let failed = false;
  await Promise.all([...cats].flatMap((cat) => langs.map(async (lang) => {
    for (let page = 1; page <= 3; page++) {
      const p = new URLSearchParams({ category: cat, status: "publish", per_page: "100", page: String(page), _fields: "id" });
      if (lang) p.set("lang", lang);
      const l: any = await searchScope.exit(() => wooRequest(auth, "GET", `${base}/products?${p}`)).catch(() => { failed = true; return []; });
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

const catalogCache = new Map<string, { at: number; value: any[] | null }>();

/**
 * A product search on a small store answered from its cached catalogue (2026-11-17,
 * prod replay latency: one list_products call made up to 12 live ?search= requests to
 * slow shared hosting, 10-14s, while the whole catalogue was already cached and fresh).
 * Inside one list_products call, a GET /products?... is answered LOCALLY when that
 * language's catalogue is fresh and has at most MAX_LOCAL_CATALOGUE products, applying
 * the same filters the store's REST API applies (search words in the title, excerpt or
 * content; include, exclude, stock, price, status, paging). A category read stays live.
 * Every search layer above keeps its own logic and normalisation; only the
 * network is gone. Otherwise the store is asked, at most LIVE_SEARCH_CAP times per call,
 * in the layers' own order (the base search first). get_product stays live, so a price or
 * stock the bot quotes for one item is current. WOO_LOCAL_SEARCH=off restores the old path.
 */
export const MAX_LOCAL_CATALOGUE = 500;
export const LIVE_SEARCH_CAP = 4;
interface SearchScope { local: number; live: number; capped: number; kinds: Record<string, number>; timeouts: number }

/**
 * Live search timing per tenant per hour (2026-11-17: timeouts still drove most of Tehila's and NE'A's
 * misses in the replay; is live slow too after warm-up, and what still goes to the network?). One
 * "[woo-perf]" line per tenant and hour: calls, ms p50/p95, timeouts, local/live/capped requests, and
 * the live requests by kind (search, category, list, include). Numbers only.
 */
interface PerfBucket { hour: string; ms: number[]; timeouts: number; local: number; live: number; capped: number; kinds: Record<string, number> }
const perf = new Map<string, PerfBucket>();
const hourOf = (t: number) => new Date(t).toISOString().slice(0, 13);
const pct = (a: number[], q: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))]; };
export function wooPerfLine(tenant: string, b: PerfBucket): string {
  const kinds = Object.entries(b.kinds).map(([k, n]) => `${k}=${n}`).join(",") || "-";
  return `[woo-perf] tenant=${tenant} hour=${b.hour} calls=${b.ms.length} p50=${pct(b.ms, 50)} p95=${pct(b.ms, 95)} timeouts=${b.timeouts} local=${b.local} live=${b.live} capped=${b.capped} live_by_kind=${kinds}`;
}
export function recordWooPerf(tenant: string, ms: number, scope: SearchScope, now = Date.now()): void {
  const hour = hourOf(now);
  let b = perf.get(tenant);
  if (b && b.hour !== hour) { console.log(wooPerfLine(tenant, b)); b = undefined; }
  if (!b) { b = { hour, ms: [], timeouts: 0, local: 0, live: 0, capped: 0, kinds: {} }; perf.set(tenant, b); }
  b.ms.push(ms); b.timeouts += scope.timeouts; b.local += scope.local; b.live += scope.live; b.capped += scope.capped;
  for (const [k, n] of Object.entries(scope.kinds)) b.kinds[k] = (b.kinds[k] ?? 0) + n;
}
/** Every tenant's bucket for a past hour, logged and dropped (called hourly; tests call it directly). */
export function flushWooPerf(now = Date.now()): string[] {
  const out: string[] = [];
  for (const [t, b] of perf) if (b.hour !== hourOf(now)) { const l = wooPerfLine(t, b); console.log(l); out.push(l); perf.delete(t); }
  return out;
}
const perfTimer = setInterval(() => flushWooPerf(), 10 * 60_000);
perfTimer.unref?.();
const searchScope = new AsyncLocalStorage<SearchScope>();
/** Local answers, live requests and capped ones, for the timing script. */
export const searchRequestCounts = { local: 0, live: 0, capped: 0 };

const strip = (h: unknown) => String(h ?? "").replace(/<[^>]*>/g, " ").toLowerCase();
/** Tests only: a store's catalogue as if read at `at`. */
export function primeCatalogCache(base: string, lang: string, list: any[] | null, at = Date.now()): void {
  catalogCache.set(`catalog|${base}|${lang}`, { at, value: list });
}
/**
 * A category's members as the store's OWN ?category= answer lists them (prod 2026-11-17:
 * Smoovee answers ?category= in about 5s, and its products' own category lists carry
 * other ids under WPML, so membership can only come from that answer). Ids only, per
 * category and language; fresh an hour, served stale up to a day while it refreshes
 * (membership changes rarely; price and stock come from the 10-minute catalogue it is
 * joined to). Filled by the warmer, and after any live category read.
 */
const CATEGORY_IDS_FRESH_MS = 60 * 60_000;
const categoryIdsCache = new Map<string, { at: number; value: string[] | null }>();
const catIdsKey = (base: string, lang: string, cat: string) => `catids|${base}|${lang}|${cat}`;
async function categoryMemberIds(auth: string, base: string, cat: string, lang: string | null): Promise<string[] | null> {
  return swrCached(categoryIdsCache, catIdsKey(base, lang ?? "", cat), CATEGORY_IDS_FRESH_MS, CATEGORY_STALE_MS, () => searchScope.exit(async () => {
    const ids: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const p = new URLSearchParams({ category: cat, status: "publish", per_page: "100", page: String(page), _fields: "id" });
      if (lang) p.set("lang", lang);
      const l: any = await wooRequest(auth, "GET", `${base}/products?${p}`);
      if (!Array.isArray(l)) return null;
      for (const x of l) if (/^\d{1,12}$/.test(String(x?.id ?? ""))) ids.push(String(x.id));
      if (l.length < 100) return ids;
    }
    return null; // more than 500: the store's own query stays the answer (kept, so it is not re-read every pass)
  }));
}
/** Tests only: a category's members as if read at `at`. */
export function primeCategoryIds(base: string, lang: string, cat: string, ids: string[] | null, at = Date.now()): void {
  categoryIdsCache.set(catIdsKey(base, lang, cat), { at, value: ids });
}

/** A GET /products?... answered from the fresh cached catalogue, or null when it cannot be. */
export function localProductList(url: string, now = Date.now()): any[] | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/\/products$/.test(u.pathname)) return null;
  const q = u.searchParams;
  // Only the parameters this emulates; anything else goes to the store.
  // "category" only through the store's own membership list (categoryMemberIds): a WPML
  // store's products list other category ids than its ?category= query returns (Smoovee).
  const known = new Set(["per_page", "page", "search", "status", "lang", "min_price", "max_price", "stock_status", "include", "exclude", "_fields", "category"]);
  if ([...q.keys()].some((k) => !known.has(k))) return null;
  const base = `${u.origin}${u.pathname.replace(/\/products$/, "")}`;
  const lang = q.get("lang") ?? "";
  const hit = catalogCache.get(`catalog|${base}|${lang}`);
  if (!hit || !Array.isArray(hit.value) || now - hit.at >= CATALOG_FRESH_MS || hit.value.length > MAX_LOCAL_CATALOGUE) return null;
  let list = hit.value.filter((p: any) => (p?.status ?? "publish") === (q.get("status") ?? "publish") || !q.get("status"));
  const search = String(q.get("search") ?? "").trim().toLowerCase();
  if (search) {
    // WordPress: every word, each in the title, the excerpt or the content.
    const terms = search.split(/\s+/).filter(Boolean);
    list = list.filter((p: any) => {
      const hay = `${String(p?.name ?? "").toLowerCase()} ${strip(p?.short_description)} ${strip(p?.description)}`;
      return terms.every((t) => hay.includes(t));
    });
  }
  const ids = (v: string | null) => new Set(String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  if (q.get("category")) {
    const cat = String(q.get("category"));
    if (!/^\d{1,12}$/.test(cat)) return null;
    const members = categoryIdsCache.get(catIdsKey(base, lang, cat));
    if (!members || !Array.isArray(members.value) || now - members.at >= CATEGORY_STALE_MS) return null;
    const inCat = new Set(members.value);
    list = list.filter((p: any) => inCat.has(String(p?.id)));
  }
  if (q.get("include")) { const inc = ids(q.get("include")); list = list.filter((p: any) => inc.has(String(p?.id))); }
  if (q.get("exclude")) { const exc = ids(q.get("exclude")); list = list.filter((p: any) => !exc.has(String(p?.id))); }
  if (q.get("stock_status")) list = list.filter((p: any) => String(p?.stock_status ?? "") === q.get("stock_status"));
  const minP = Number(q.get("min_price") ?? NaN), maxP = Number(q.get("max_price") ?? NaN);
  if (Number.isFinite(minP)) list = list.filter((p: any) => Number(p?.price) >= minP);
  if (Number.isFinite(maxP)) list = list.filter((p: any) => Number(p?.price) <= maxP);
  const per = Math.max(1, Math.min(100, Number(q.get("per_page") ?? 10) || 10));
  const page = Math.max(1, Number(q.get("page") ?? 1) || 1);
  return list.slice((page - 1) * per, page * per);
}

/**
 * Stores whose products are sold by size (most of them name a footprint:
 * Smoovee's "משטח הזזה 34*38 ס\"מ"). For such a store a device the search
 * does not know is a question of its base size, not "not found".
 */
const sizedStores = new Map<string, boolean>();
const storeKey = (u: string) => { try { return new URL(u).origin.toLowerCase(); } catch { return u.toLowerCase(); } };
function rememberSizedStore(base: string, list: any[]): void {
  const products = list.filter((p: any) => (p?.status ?? "publish") === "publish");
  if (!products.length) return;
  sizedStores.set(storeKey(base), products.filter((p: any) => footprintOf(p)).length > products.length / 2);
}
export function storeSellsBySize(storeUrl: string): boolean {
  return sizedStores.get(storeKey(storeUrl)) === true;
}

/**
 * The store's whole published catalogue, at most two pages of 100, ten
 * minutes per store and language; null when it is bigger (a full second page).
 * A Hebrew ask reads lang=he: on a WPML / Polylang store that is the Hebrew
 * catalogue (its own ids, which the cards then use); a store without them
 * ignores the parameter and answers its one catalogue.
 */
async function wholeCatalog(auth: string, base: string, lang: string | null): Promise<any[] | null> {
  const key = `catalog|${base}|${lang ?? ""}`;
  return swrCached(catalogCache, key, CATALOG_FRESH_MS, CATALOG_STALE_MS, async () => {
    // The loader always reads the store itself, never the local answers below (a
    // background refresh started inside a search must reach the store).
    const page = (n: number) => searchScope.exit(async () => {
      const p = new URLSearchParams({ per_page: "100", page: String(n), status: "publish" });
      if (lang) p.set("lang", lang);
      const l: any = await wooRequest(auth, "GET", `${base}/products?${p}`);
      return Array.isArray(l) ? l : [];
    });
    // Two pages at once (a small store answers page 2 empty); up to MAX_LOCAL_CATALOGUE.
    const [first, second] = await Promise.all([page(1), page(2).catch(() => [] as any[])]);
    let list: any[] | null = first.length < 100 ? first : second.length < 100 ? [...first, ...second] : null;
    if (!list) {
      const more = await Promise.all([3, 4, 5].map((n) => page(n).catch(() => [] as any[])));
      const pages = [first, second, ...more];
      const end = pages.findIndex((l) => l.length < 100);
      list = end < 0 ? null : pages.slice(0, end + 1).flat();
    }
    if (list) rememberSizedStore(base, list);
    return list;
  });
}

/**
 * Fill the store caches a search needs (categories and the whole catalogue, in
 * every language a turn may read), off any customer's turn: at boot and on a
 * timer (woo-cache-warmer.service). Read-only GETs; never throws.
 */
export async function warmWooCatalog(credentials: Record<string, any>, config: Record<string, any>): Promise<{ ms: number; ok: boolean }> {
  const t0 = Date.now();
  try {
    const consumerKey = credentials.consumerKey || credentials.consumer_key;
    const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
    const storeUrl = String(config?.storeUrl || credentials.storeUrl || credentials.store_url || "").replace(/\/$/, "");
    if (!consumerKey || !consumerSecret || !storeUrl) return { ms: 0, ok: false };
    const base = `${storeUrl}/wp-json/wc/v3`;
    const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
    // The languages a turn reads in: none on a single-language store; he and en on a WPML one.
    const langs: Array<string | null> = productLanguage({}, config) ? [null, "he", "en"] : [null, "he"];
    const allowed = categoryAllowList(config);
    await Promise.all([
      ...langs.flatMap((l) => [storeCategories(auth, base, l), wholeCatalog(auth, base, l).catch(() => null)]),
      ...(allowed ? [allowedProductIds(auth, base, allowed).catch(() => null)] : []),
    ]);
    // Each category's members as the store lists them (only those past their hour are read again).
    await Promise.all(langs.map(async (l) => {
      const cats = (await storeCategories(auth, base, l).catch(() => null))?.list ?? [];
      await Promise.all(cats.filter((c: any) => /^\d{1,12}$/.test(String(c?.id ?? "")) && Number(c?.count ?? 1) > 0).slice(0, 60)
        .map((c: any) => categoryMemberIds(auth, base, String(c.id), l).catch(() => null)));
    }));
    return { ms: Date.now() - t0, ok: true };
  } catch {
    return { ms: Date.now() - t0, ok: false };
  }
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
  // The usage notes are not what a product fits (Smoovee: "במידה וסמובי זה
  // נרכש עבור מיקסר מכל דגם, יש לרכוש מעצור" made ten surfaces "fit" a mixer).
  const docs = pool.map((p) => ({ p, strong: flat(`${p?.name ?? ""} ${withoutUsageNotes(p?.short_description)}`), weak: flat(withoutUsageNotes(p?.description)) }));
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
 * A product's footprint in cm, from its title ("35*28 ס\"מ", "35x28cm",
 * "14×40.5") or its copy ("אורך: 28 ס\"מ ... רוחב: 35 ס\"מ", "Length: 28 cm
 * Width: 35 cm"). Null when it names none (a round one, "בקוטר 21", is not a
 * rectangle and is left out).
 */
export function footprintOf(p: any): [number, number] | null {
  const num = (v: string) => Number(v.replace(",", "."));
  const name = decodeEntities(String(p?.name ?? ""));
  const m = /(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)/i.exec(name);
  if (m) return [num(m[1]), num(m[2])];
  const t = decodeEntities(String(p?.short_description ?? "").replace(/<[^>]*>/g, " "));
  const len = /(?:אורך|length)\s*:?\s*(\d+(?:[.,]\d+)?)/i.exec(t), wid = /(?:רוחב|width)\s*:?\s*(\d+(?:[.,]\d+)?)/i.exec(t);
  return len && wid ? [num(len[1]), num(wid[1])] : null;
}

/**
 * What fits under a base of a x b cm (Smoovee prod 2026-11-08: a KitchenAid
 * mixer, base 40 x 20, was offered Alice 31 x 41 while Christina 23 x 40 fits
 * and is smaller): the products at least that size both ways, turned either
 * way, smallest first. Null when no product names a footprint (not such a
 * store: the search goes on as usual).
 */
export function fitsBase(list: any[], a: number, b: number): any[] | null {
  const sized = list.map((p) => ({ p, f: footprintOf(p) })).filter((x) => x.f);
  if (!sized.length) return null;
  const fits = sized.filter(({ f }) => (f![0] >= a && f![1] >= b) || (f![0] >= b && f![1] >= a));
  return fits.sort((x, y) => x.f![0] * x.f![1] - y.f![0] * y.f![1]).map((x) => x.p);
}

/** A product may be this much smaller than the base, per side: it stands on feet (the owner's picks, 11-15). */
export const FIT_TOLERANCE_CM = 2;

/**
 * The closest fit for each base size the customer gave (Smoovee owner,
 * 2026-11-15: a 21 x 24 base takes Monica 20 x 25, a 22 x 35 base takes
 * Christina 23 x 40, a 49 x 32 microwave has none: "our largest is Asaf 33 x 46").
 * A product fits when it is no more than FIT_TOLERANCE_CM smaller than the base
 * on each side, turned either way; the closest is the one whose area is
 * nearest the base's, in stock first. One size: the closest and one other
 * size as a second choice. Several sizes: the closest for each, marked with
 * the size it is for. A size nothing fits: the store's largest, marked
 * too_small, so the bot can say so honestly. Null when no product names a
 * footprint (not such a store).
 */
export function closestFits(list: any[], sizes: Array<[number, number]>): any[] | null {
  const sized = list.map((p) => ({ p, f: footprintOf(p) })).filter((x) => x.f) as Array<{ p: any; f: [number, number] }>;
  if (!sized.length) return null;
  const T = FIT_TOLERANCE_CM;
  const out: any[] = [];
  const seen = new Set<string>();
  const add = (x: { p: any; f: [number, number] }, size: [number, number], extra: Record<string, unknown> = {}) => {
    const id = String(x.p?.id);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...x.p, matched_in: "dimensions", footprint_cm: x.f, fit_for: size, ...extra });
  };
  const outOfStock = (p: any) => p?.stock_status === "outofstock";
  for (const size of sizes) {
    const [a, b] = size, area = a * b;
    const fits = sized
      .filter(({ f }) => (f[0] >= a - T && f[1] >= b - T) || (f[0] >= b - T && f[1] >= a - T))
      .sort((x, y) => Number(outOfStock(x.p)) - Number(outOfStock(y.p)) || Math.abs(x.f[0] * x.f[1] - area) - Math.abs(y.f[0] * y.f[1] - area));
    if (!fits.length) {
      const largest = [...sized].sort((x, y) => Number(outOfStock(x.p)) - Number(outOfStock(y.p)) || y.f[0] * y.f[1] - x.f[0] * x.f[1])[0];
      add(largest, size, { too_small: true });
      continue;
    }
    add(fits[0], size);
    if (sizes.length === 1) {
      // A second choice of another size (not the same footprint in another finish).
      const area0 = fits[0].f[0] * fits[0].f[1];
      const next = fits.slice(1).find((x) => x.f[0] * x.f[1] !== area0);
      if (next) add(next, size, { second_choice: true });
    }
  }
  return out;
}

/**
 * The products whose NAME holds one of these words, read from the store's
 * cached catalogue rather than its search (Smoovee prod 2026-11-13: the
 * store's own lang=he search answers nothing for "אלכסה" although product
 * 1433 is "סמובי אלכסה", so "אליס ואלכסה" found only Alice). A name is a
 * product's own word for itself, so this holds for any store; a catalogue too
 * big to cache (over two pages) gives nothing here and the search is as before.
 */
async function catalogNamed(
  auth: string, base: string, params: URLSearchParams, words: string[], visible: (l: any) => any,
): Promise<any[]> {
  if (!words.length) return [];
  const all = await wholeCatalog(auth, base, params.get("lang") || "he").catch(() => null);
  if (!all) return [];
  const minP = Number(params.get("min_price") ?? NaN), maxP = Number(params.get("max_price") ?? NaN);
  const pool = (visible(all) as any[]).filter((p: any) =>
    (p?.status ?? "publish") === "publish"
    && (params.get("stock_status") !== "instock" || p?.stock_status !== "outofstock")
    && (!Number.isFinite(minP) || Number(p?.price) >= minP)
    && (!Number.isFinite(maxP) || Number(p?.price) <= maxP));
  // A word most of the catalogue's names hold names nothing in particular
  // ("משטח" is in 27 of Smoovee's 30 names), the same rule as descriptionSearch.
  const specific = words.filter((w) => {
    const n = pool.filter((p) => nameHolds(p, w)).length;
    return n > 0 && n <= pool.length / 2;
  });
  return specific.length ? pool.filter((p) => specific.some((w) => nameHolds(p, w))) : [];
}

/**
 * A Hebrew product ask, deterministic (see list_products). Logs which route
 * found it: [woo-search] hit=category:<id> | title | variant:<word> | none.
 */
/**
 * The customer's Hebrew words the model's query dropped (rating d7782dd2, Tehila: "בובון לקשירה נמוכה" searched
 * as "מטפחת לקשירה נמוכה", and her bobbons were never searched). Their own route then runs too.
 */
export function droppedCustomerWords(own: string, modelQuery: string): string[] {
  const theirs = new Set(searchWords(modelQuery).map((w) => hebrewStem(w)));
  return searchWords(own).filter((w) => /[א-ת]/.test(w) && w.length >= 3 && !HEBREW_STOP.has(hebrewStem(w)) && !theirs.has(hebrewStem(w)));
}

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
  if (words.every((w) => STOCK_ASK.has(hebrewStem(w)) || STAND_WORDS.has(hebrewStem(w)))) {
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
  // The words' other forms, only after an empty first round, all at once (prod replay 11:
  // searching them with the first round made a small store slower for every request).
  const variants = words.filter((w) => /[א-ת]/.test(w)).flatMap(hebrewVariants).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  const [inCat, whole, local, ...perWord] = await Promise.all([
    cat ? get(byCat) : Promise.resolve([] as any[]),
    get(params).then((l) => l.filter((p: any) => words.some((w) => nameHolds(p, w)))),
    // The same words the store's search is asked for, by name, from the cached
    // catalogue: the store's index can miss a name it holds.
    // Every word of hers, the ones a category name accounts for too (rating ed780586: a category whose name
    // holds "בובון" took the word, and the bobbon titles were never looked up).
    catalogNamed(auth, base, params, words.length > 1 ? rest.slice(0, 2) : rest, visible),
    ...(words.length > 1 ? rest.slice(0, 2).map(restSearch) : []),
  ]);
  const named = [...perWord.flat(), ...local, ...(wantsStock && !rest.length ? [] : whole)].filter((p: any) => !wantsStock || p?.stock_status !== "outofstock");
  // The name that holds the most of the words first: "סמובי" is in every one of
  // Smoovee's names, so "סמובי אלכסה" listed the catalogue in its own order
  // and Alexa came tenth (11-14 19:18, Ariel shown). Stable for equal counts.
  const heldBy = (p: any) => words.filter((w) => nameHolds(p, w)).length;
  named.sort((a: any, b: any) => heldBy(b) - heldBy(a));
  // What the customer named is in a product's own "מתאים ל" list: those first,
  // unless an in-stock product's NAME holds the words (the customer named it).
  if (!named.some((p: any) => p?.stock_status !== "outofstock")) {
    const all = await wholeCatalog(auth, base, params.get("lang") || "he").catch(() => null);
    const fitted = all ? fitListMatches((visible(all) as any[]).filter((p: any) => (p?.status ?? "publish") === "publish" && (!wantsStock || p?.stock_status !== "outofstock")), query, per) : [];
    if (fitted.length) {
      const seen = new Set<string>();
      const out = [...fitted, ...named].filter((p: any) => !seen.has(String(p?.id)) && seen.add(String(p?.id)));
      log("fits_list", fitted.length);
      return out.slice(0, per);
    }
  }
  if (inCat.length) {
    const catIds = new Set(inCat.map((p: any) => String(p?.id)));
    // A product the words name AND in the category first ("מטפחת אנה"), then the category, then other title hits.
    const both = named.filter((p: any) => catIds.has(String(p?.id)));
    // A title that holds a word of the customer's own the category does not account for wins over the
    // category's other products (prod rating 2026-11-18, Tehila: "בובון לקשירה נמוכה" routed to scarves by
    // "קשירה", and "בובון שטוח" sat after ten scarves).
    const titled = named.filter((p: any) => !catIds.has(String(p?.id)) && rest.some((w) => nameHolds(p, w)));
    const seen = new Set<string>();
    const out = [...both, ...inStockFirst(titled), ...inStockFirst(inCat), ...named].filter((p: any) => !seen.has(String(p?.id)) && seen.add(String(p?.id)));
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
  const found = await Promise.all(variants.map((v) => restSearch(v).catch(() => [] as any[])));
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
 * A firewall answered instead of WooCommerce (prod 2026-11-11 alphamom.co.il,
 * 2026-11-15 chanivainberger.co.il): Cloudflare's bot challenge returns 403
 * "Just a moment..." to any server, whatever the keys. Cloudflare marks it
 * with cf-mitigated: challenge; the page itself carries cf-chl / challenge-
 * platform. Its block page (1020, "Attention Required! | Cloudflare") and the
 * other common WordPress firewalls' block pages say the same thing: the keys
 * were never checked. Read from at most the first 64 KB of the body.
 */
export const STORE_FIREWALL_CHALLENGE = "store_firewall_challenge";
const FIREWALL_BODY = /Just a moment\.\.\.|cf-chl|challenge-platform|cf_chl_opt|Attention Required! \| Cloudflare|cf-error-details|Sucuri WebSite Firewall|imunify360|bot-protection/i;
export function isFirewallChallenge(status: number, headers: { get(name: string): string | null }, body: string): boolean {
  if (![403, 429, 503].includes(status)) return false;
  if (String(headers.get("cf-mitigated") ?? "").toLowerCase() === "challenge") return true;
  return FIREWALL_BODY.test(body.slice(0, 64 * 1024));
}

/** Which firewall answered, so the merchant is told the right fix: Cloudflare's rule, or their host or security plugin. */
export type StoreFirewall = "cloudflare" | "sucuri" | "imunify360" | "other";
export function firewallOf(headers: { get(name: string): string | null }, body: string): StoreFirewall {
  const b = body.slice(0, 64 * 1024);
  if (headers.get("cf-mitigated") || headers.get("cf-ray") || /cf-chl|challenge-platform|cf_chl_opt|Cloudflare/i.test(b)) return "cloudflare";
  if (/Sucuri WebSite Firewall/i.test(b) || headers.get("x-sucuri-id")) return "sucuri";
  if (/imunify360/i.test(b)) return "imunify360";
  return "other";
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
      // Read defensively: a missing or failing body is just "no markers".
      const body = typeof (res as any).text === "function" ? await (res as any).text().catch(() => "") : "";
      // A firewall, not the store: the keys were never checked, and the other
      // path would meet the same wall. Its own reason, so the merchant is told
      // to allow us, not to make new keys.
      if (isFirewallChallenge(res.status, res.headers, body)) return { ok: false, reason: STORE_FIREWALL_CHALLENGE };
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
  async validate({ ctx, credentials, config }) {
    const consumerKey = credentials.consumerKey || credentials.consumer_key;
    const consumerSecret = credentials.consumerSecret || credentials.consumer_secret;
    if (!consumerKey || !consumerSecret) return { ok: false, error: "Enter both the consumer key and the consumer secret." };
    const storeUrl = normalizeStoreUrl(config.storeUrl || credentials.storeUrl || credentials.store_url);
    if (!storeUrl) return { ok: false, error: "Enter the store's https:// address." };
    const v = await validateWooKeys(storeUrl, String(consumerKey), String(consumerSecret));
    if (!v.ok && v.reason === STORE_FIREWALL_CHALLENGE) {
      // The store being connected may be probed ("Test GOTCHA access") for an hour.
      if (ctx?.tenantId) {
        const { rememberPendingStore } = await import("../woo-store-probe.service");
        await rememberPendingStore(ctx.tenantId, storeUrl);
      }
      // The address to let through goes with it (config: lib/egress); the IP rule first.
      const { egressConfig, firewallFixMessage } = await import("../../lib/egress");
      const egress = egressConfig();
      return { ok: false, code: STORE_FIREWALL_CHALLENGE, egress, error: firewallFixMessage(egress) } as any;
    }
    return v.ok
      ? { ok: true }
      : { ok: false, error: v.reason === "http_401" || v.reason === "http_403"
          ? "The store rejected these keys. Check that they are Read/Write keys for this store."
          : `The store could not be reached to check the keys (${v.reason}).` };
  },

  async execute({ toolName, args, credentials, config, ctx }: any) {
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
        // One scope per tool call: local answers on a small fresh catalogue, a live cap otherwise.
        if (!searchScope.getStore() && process.env.WOO_LOCAL_SEARCH !== "off") {
          const scope: SearchScope = { local: 0, live: 0, capped: 0, kinds: {}, timeouts: 0 };
          const t0 = Date.now();
          try {
            const out = await searchScope.run(scope, () => WooCommerceAdapter.execute({ toolName, args, credentials, config, ctx } as any));
            console.log(`[woo-search] requests local=${scope.local} live=${scope.live} capped=${scope.capped}`);
            return out;
          } finally {
            if (ctx?.tenantId) recordWooPerf(String(ctx.tenantId), Date.now() - t0, scope);
          }
        }
        // By meaning, when the store's own search found nothing (2026-11-16,
        // catalog-semantic.service): the whole search below runs first, with
        // every retry it has; only an empty answer reaches the catalogue's
        // embeddings. Internal callers (ids, a category, a kind) are left as
        // they are. The flag stops the inner call from wrapping again.
        if (!args._semantic && ctx?.tenantId && !args.include && !args.category && !args.kind && String(args.customer_query ?? args.query ?? "").trim()) {
          const plain: any = await WooCommerceAdapter.execute({ toolName, args: { ...args, _semantic: true }, credentials, config, ctx } as any);
          if (!Array.isArray(plain) || plain.length) return plain;
          const all = await wholeCatalog(auth, base, lang).catch(() => null);
          if (!all?.length) return plain;
          const minP = Number(args.price_min), maxP = Number(args.price_max);
          const shown = all.filter((p: any) =>
            p?.catalog_visibility !== "hidden" && (p?.status ?? "publish") === "publish" && wooProductAllowed(storeUrl, p) &&
            (!(minP > 0) || Number(p?.price) >= minP) && (!(maxP > 0) || Number(p?.price) <= maxP));
          const per = Math.min(10, Number(args.per_page ?? 10));
          const q = String(args.customer_query || args.query);
          const hits = await semanticProductSearch({ tenantId: ctx.tenantId, storeKey: storeUrl, products: shown, query: q, limit: Math.min(per, 5) });
          const inStock = (p: any) => p?.stock_status === "instock" || p?.stock_status === "onbackorder";
          const out = (args.in_stock === true && hits.some((h) => inStock(h.product)) ? hits.filter((h) => inStock(h.product)) : hits)
            .map((h) => ({ ...h.product, matched_in: "related" }));
          console.log(`[woo-search] semantic fallback query=${JSON.stringify(q.slice(0, 60))} catalogue=${shown.length} results=${out.length} top=${hits[0]?.score?.toFixed(3) ?? "-"}`);
          return out.length ? out : plain;
        }
        // "In stock only" is often the model's own addition: an empty in-stock
        // search is searched again without it, so a sold-out product is said to
        // be sold out (each product carries stock_status), never "not found".
        if (args.in_stock === true && !args._stockRetried) {
          const strict: any = await WooCommerceAdapter.execute({ toolName, args: { ...args, _stockRetried: true }, credentials, config, ctx } as any);
          if (!Array.isArray(strict) || strict.length) return strict;
          const any: any = await WooCommerceAdapter.execute({ toolName, args: { ...args, in_stock: undefined, _stockRetried: true }, credentials, config, ctx } as any);
          console.log(`[woo-search] in_stock empty, searched without it: results=${Array.isArray(any) ? any.length : "n/a"}`);
          return Array.isArray(any) && any.length ? any : strict;
        }
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
            ctx,
          } as any);
          if (!cat || !Array.isArray(found)) return Array.isArray(found) ? found.slice(0, per) : found;
          const forThem = found.filter((p: any) => (p?.categories ?? []).some((c: any) => String(c?.id) === cat));
          // A product she named is hers whatever category it sits in (rating ed780586, Tehila: "מחפשת" made the
          // model pass audience=women, and the bobbons, outside the Women category, were dropped for scarves).
          const herWords = searchWords(String(args.customer_query ?? args.query ?? "")).filter((w) => w.length >= 3 && !HEBREW_STOP.has(hebrewStem(w)) && !STOCK_ASK.has(hebrewStem(w)));
          const holds = (p: any) => herWords.some((w) => nameHolds(p, w));
          if (forThem.length && !forThem.some(holds)) {
            const other = await audienceCategory(auth, base, audience === "men" ? "women" : "men").catch(() => null);
            const extra = found.filter((p: any) => !forThem.includes(p) && holds(p) && !(other && (p?.categories ?? []).some((c: any) => String(c?.id) === other)));
            if (extra.length) {
              console.log(`[woo-search] audience=${audience} named_outside=${extra.length} for_audience=${forThem.length}`);
              return [...extra.map((p: any) => ({ ...p, outside_audience: audience })), ...forThem].slice(0, per);
            }
          }
          if (forThem.length || !found.length) return forThem.slice(0, per);
          // None in the store's Men / Women category (unisex socks): what the
          // search found, each marked, so the bot never says the store lacks it.
          console.log(`[woo-search] audience=${audience} empty, the search's own results=${found.length}`);
          return found.slice(0, per).map((p: any) => ({ ...p, outside_audience: audience }));
        }
        // The customer wrote Hebrew and the model searched in Latin (Tehila:
        // "מטפחה חגיגית" sent as "scarf", every scarf instead of the festive
        // ones). On a store whose catalogue is Hebrew, the customer's own words
        // run the Hebrew route alongside the model's query, and what they find
        // comes first, unless they found only copy and the model found more.
        // An English-title store (urban) keeps the model's translation as it is.
        // A base size the customer gave (fits_cm, set by the bot from their own
        // words): the catalogue's products that fit it, smallest first, in stock
        // first; the model only phrases them. A store whose products name no size
        // searches as usual.
        // Every size the customer gave (two devices, two sizes: 11-14 21:25).
        const pair = (v: unknown): [number, number] | null =>
          Array.isArray(v) && v.length === 2 && v.every((n: unknown) => Number(n) > 0 && Number(n) < 1000) ? [Number(v[0]), Number(v[1])] : null;
        const sizes = (Array.isArray(args.fits_cm_all) ? (args.fits_cm_all as unknown[]).map(pair) : [pair(args.fits_cm)])
          .filter((x): x is [number, number] => !!x).slice(0, 4);
        if (sizes.length && !args.include && !args.category) {
          const visibleNow = (l: any[]) => l.filter((p: any) => p?.catalog_visibility !== "hidden" && (p?.status ?? "publish") === "publish" && wooProductAllowed(storeUrl, p));
          const all = await wholeCatalog(auth, base, lang ?? (/[א-ת]/.test(String(args.customer_query ?? args.query ?? "")) ? "he" : null)).catch(() => null);
          const picks = all ? closestFits(visibleNow(all), sizes) : null;
          if (picks) {
            const per = Math.min(10, Number(args.per_page ?? 10));
            const out = picks.slice(0, per);
            console.log(`[woo-search] fits=${sizes.map((x) => x.join("x")).join(",")} results=${out.length} picks=${out.map((p: any) => `${p.id}:${(p.footprint_cm ?? []).join("x")}${p.too_small ? "(too-small)" : ""}`).join(",") || "none"}`);
            return out;
          }
        }
        const own = typeof args.customer_query === "string" ? args.customer_query.trim() : "";
        if (own && /[א-ת]/.test(own) && (!/[א-ת]/.test(String(args.query ?? "")) || (genericStoreQuery(args.query) && !genericStoreQuery(own)) || droppedCustomerWords(own, String(args.query ?? "")).length > 0) && !args.include && !args.category) {
          const rest = { ...args, customer_query: undefined };
          if (await storeCatalogIsHebrew(auth, base, lang).catch(() => false)) {
            const per = Math.min(100, Number(args.per_page ?? 10));
            const [mine, theirs]: any[] = await Promise.all([
              WooCommerceAdapter.execute({ toolName, args: { ...rest, query: own, kind: undefined, rank: undefined }, credentials, config, ctx } as any).catch(() => []),
              WooCommerceAdapter.execute({ toolName, args: rest, credentials, config, ctx } as any),
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
            ctx,
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
        // A budget of 0 is no budget (gpt-6-luna fills every field: price_max 0).
        if (price(args.price_max) && Number(args.price_max) > 0) params.set("max_price", price(args.price_max)!);
        if (args.in_stock === true) params.set("stock_status", "instock");
        if (args.on_sale === true) params.set("on_sale", "true");
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
          const heHits = await hebrewProductSearch(auth, base, params, String(args.query), Math.min(100, Number(args.per_page ?? 10)), visible);
          if (heHits.length || !ctx?.tenantId || args._translated) return heHits;
          // Eval A05 (dev 2026-11-15): "גרביים" on an English-title store found
          // nothing and the model said "לא מצאנו" rather than retry in English.
          // On a store whose catalogue is not Hebrew, the words in English, once.
          if (await storeCatalogIsHebrew(auth, base, lang).catch(() => true)) return heHits;
          const { productQueryInEnglish } = await import("../query-translation.service");
          const en = await productQueryInEnglish(ctx.tenantId, String(args.query)).catch(() => null);
          if (!en) return heHits;
          const found: any = await WooCommerceAdapter.execute({ toolName, args: { ...args, query: en, _translated: true }, credentials, config, ctx } as any);
          console.log(`[woo-search] hebrew empty on a non-Hebrew catalogue: ${JSON.stringify(String(args.query).slice(0, 40))} -> ${JSON.stringify(en)} results=${Array.isArray(found) ? found.length : "n/a"}`);
          return Array.isArray(found) && found.length ? found : heHits;
        }
        // An allow-list filters after the read: read a whole page, then cut (the
        // store's newest ten may all be outside it, Smoovee's Woody line).
        const perAsked = Number(params.get("per_page") ?? 10);
        const read = new URLSearchParams(params);
        if (wooStoreHasAllowList(storeUrl)) read.set("per_page", "100");
        // The category the words name is read ALONGSIDE the title search, not after it
        // (prod 2026-11-17: a cold ?category= takes ~5s on a slow store). Used only when
        // the title search finds nothing by title; local when its members are cached.
        // The title search is sent first; the category lookup (cached categories) follows it.
        const listedP: Promise<any> = wooRequest(auth, "GET", `${base}/products?${read}`);
        listedP.catch(() => {});
        const catFor = args.query && !params.has("category") && !params.has("include")
          ? Promise.resolve().then(() => categoryForQuery(auth, base, args.query, params.get("lang"))).catch(() => null)
          : Promise.resolve(null);
        const byCatEarly: Promise<any[] | null> = catFor.then(async (cat) => {
          if (!cat?.id) return null;
          const byCat = new URLSearchParams(params);
          byCat.delete("search");
          byCat.set("category", String(cat.id));
          const l: any = visible(await wooRequest(auth, "GET", `${base}/products?${byCat}`));
          return Array.isArray(l) ? l : [];
        }).catch(() => null);
        const listed: any = visible(await listedP);
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
          const inCat = await byCatEarly;
          if (inCat) {
            add(inCat);
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
        // In the product's language (WPML: a Hebrew product's variations are not
        // in the default language's answer, Smoovee 4057 carded with none).
        return await wooRequest(auth, "GET", `${base}/products/${encodeURIComponent(String(args.product_id))}/variations?per_page=${per}${lang ? `&lang=${lang}` : ""}`);
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
        // All forms of the phone at once, within the store's request cap (Tehila: 6.4s in series).
        const all = await Promise.all(terms.map((term) => query({ search: term }).catch(() => [])));
        for (const rows of all) for (const o of Array.isArray(rows) ? rows : []) if (o?.id != null) found.set(String(o.id), o);
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

const storeSlots = new Map<string, { active: number; queue: Array<() => void> }>();
const storeConcurrency = () => { const n = Number(process.env.WOO_STORE_CONCURRENCY); return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : 3; };
/** Run fn with one of the store's slots: at most storeConcurrency() at a time per store origin; the rest wait in order. */
export async function withStoreSlot<T>(url: string, fn: () => Promise<T>): Promise<T> {
  let key: string;
  try { key = new URL(url).origin; } catch { key = url; }
  let slot = storeSlots.get(key);
  if (!slot) { slot = { active: 0, queue: [] }; storeSlots.set(key, slot); }
  const s = slot;
  if (s.active >= storeConcurrency()) await new Promise<void>((resolve) => s.queue.push(resolve));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.queue.shift()?.();
  }
}

async function wooRequest(authHeader: string, method: string, url: string, body?: unknown): Promise<unknown> {
  const scope = method === "GET" ? searchScope.getStore() : undefined;
  if (scope && /\/products\?/.test(url)) {
    const local = localProductList(url);
    if (local) { scope.local++; searchRequestCounts.local++; rememberListed(url, local); return local; }
    if (scope.live >= LIVE_SEARCH_CAP) { scope.capped++; searchRequestCounts.capped++; return []; }
    scope.live++; searchRequestCounts.live++;
    const kind = /[?&]category=/.test(url) ? "category" : /[?&]search=/.test(url) ? "search" : /[?&]include=/.test(url) ? "include" : "list";
    scope.kinds[kind] = (scope.kinds[kind] ?? 0) + 1;
    // A category read the catalogue could not answer: learn its members for the next one,
    // AFTER this read (the customer's request goes to the store first).
    const out = await wooRequestLive(authHeader, method, url, body).catch((err: any) => {
      if (/woocommerce_timeout/.test(String(err?.message ?? ""))) scope.timeouts++;
      throw err;
    });
    try {
      const u = new URL(url);
      const cat = u.searchParams.get("category");
      if (cat && /^\d{1,12}$/.test(cat)) void categoryMemberIds(authHeader, `${u.origin}${u.pathname.replace(/\/products$/, "")}`, cat, u.searchParams.get("lang")).catch(() => null);
    } catch { /* not a URL */ }
    return out;
  }
  return wooRequestLive(authHeader, method, url, body);
}

async function wooRequestLive(authHeader: string, method: string, url: string, body?: unknown): Promise<unknown> {
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
  // At most WOO_STORE_CONCURRENCY requests at once per store (prod replay 11: more
  // parallel GETs made a small shared-hosting store slower for every one of them).
  const res = await withStoreSlot(url, () => fetch(url, { ...init, signal: AbortSignal.timeout(wooRequestTimeoutMs()) })).catch((err: any) => {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new Error("woocommerce_timeout: the store did not answer in time");
    throw err;
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A firewall, not the store (a connected store that later meets Cloudflare's
    // challenge): its own error, which the framework records on the connection.
    if (isFirewallChallenge(res.status, res.headers, text)) {
      throw new Error(`${STORE_FIREWALL_CHALLENGE}: the store's firewall (${firewallOf(res.headers, text)}) answered instead of WooCommerce`);
    }
    throw new Error(`woocommerce_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  const out = await res.json();
  const ms = Date.now() - startedAt;
  // One line per store request: which kind, how long (her host is slow only at moments).
  if (ms > 3000) console.warn(`[woo-request] slow ${method} ${new URL(url).pathname.replace(/^.*\/wc\/v3/, "")} ${ms}ms`);
  // Step-by-step timing for the timing script (WOO_REQUEST_TRACE=1): the path and the
  // parameter NAMES only, never their values (a search value is the customer's words).
  if (process.env.WOO_REQUEST_TRACE === "1") {
    const u = new URL(url);
    console.log(`[woo-trace] ${method} ${u.pathname.replace(/^.*\/wc\/v3/, "")}?${[...u.searchParams.keys()].join(",")} ${ms}ms`);
  }
  if (method === "GET") rememberListed(url, out);
  return out;
}

registerAdapter(WooCommerceAdapter);
export default WooCommerceAdapter;
