/**
 * Platform-first harvesting: what a store publishes as data, read as data.
 *
 * Shopify serves its catalogue at /products.json and its policies at fixed
 * /policies/* paths; WooCommerce serves the Store API at /wp-json/wc/store/v1.
 * Reading those is exact where scraping product tiles is a guess, so the scan
 * asks the platform first and crawls for everything else.
 *
 * Every request goes through safeFetch (SSRF-hardened, the target is
 * user-supplied). Pure functions over an injected fetcher, so tests need no
 * network. Read-only, public endpoints only - nothing here authenticates to a
 * store.
 */
import { safeFetch } from "@chatcenter/shared";
import { GOTCHA_CRAWLER_UA, decodeEntities } from "../site-crawl.service";

export interface FetchResult { ok: boolean; status: number; text: string; contentType?: string }
export type Fetcher = (url: string, opts?: { timeoutMs?: number; accept?: string }) => Promise<FetchResult | null>;


export const defaultFetcher: Fetcher = async (url, opts = {}) => {
  const r = await safeFetch(url, {
    method: "GET",
    headers: { "User-Agent": GOTCHA_CRAWLER_UA, Accept: opts.accept ?? "application/json,text/html;q=0.9,*/*;q=0.8" },
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  return r.error && !r.status ? null : { ok: r.ok, status: r.status, text: r.text, contentType: r.contentType };
};

export type Platform = "shopify" | "woocommerce" | null;

export interface ProductsSummary {
  count: number;
  /** True when there were more than we paged through. */
  more: boolean;
  categories: string[];
  priceRange: { min: number; max: number; currency: string | null } | null;
  inStock: number;
  highlights: Array<{ title: string; url: string | null; price: number | null }>;
  /**
   * Every product, for a catalogue of at most ITEMS_MAX (Smoovee 2026-11-08:
   * what a product fits, "מתאים ל: תמי 4", is only in its short description,
   * and the 8 highlights never carried it). Written to the products document,
   * one section each; not kept in the discovery row.
   */
  items?: Array<{ title: string; url: string | null; price: number | null; categories: string[]; details: string }>;
  source: "shopify_feed" | "woo_store_api";
}

/** The most products the products document lists one by one. */
export const ITEMS_MAX = 200;
const DETAILS_MAX = 400;

/** A product's HTML copy as one line of text, cut at a word near DETAILS_MAX. */
export function plainDetails(html: unknown): string {
  const t = decodeEntities(String(html ?? "").replace(/<\/(li|p|div|h\d)>|<br\s*\/?>/gi, " · ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").replace(/(\s*·\s*)+/g, " · ").replace(/^\s*·\s*|\s*·\s*$/g, "").trim();
  if (t.length <= DETAILS_MAX) return t;
  const cut = t.slice(0, DETAILS_MAX);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), DETAILS_MAX - 40)).trim() + "…";
}

export interface PlatformHarvest {
  platform: Platform;
  products: ProductsSummary | null;
  /** Pages the platform says hold its policies; read first by the crawl. */
  policyUrls: string[];
  /** Why the feed could not be read, when the platform was known but its feed was not. */
  feedUnavailable?: "disabled" | "unreadable";
}

function json(r: FetchResult | null): any {
  if (!r || !r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

/** The categories that cover the most products, most common first. */
function topCategories(names: string[], cap = 8): string[] {
  const n = new Map<string, number>();
  for (const raw of names) {
    const k = raw.trim();
    if (k) n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([k]) => k);
}

/**
 * Which platform answers as one. HTML markers come from the crawl's own
 * detection (`hinted`); when they say nothing, the platform's data endpoint is
 * asked directly - a store can hide its theme markers, not its API.
 */
export async function detectPlatform(origin: string, hinted: string | null | undefined, fetch: Fetcher = defaultFetcher): Promise<Platform> {
  // The data endpoint is the proof. A page that merely MENTIONS WooCommerce
  // (a marketing site listing its integrations) is not a WooCommerce store,
  // and found that way on a real site (2026-10-23).
  const shop = json(await fetch(new URL("/products.json?limit=1", origin).toString(), { timeoutMs: 6000 }));
  if (shop && Array.isArray(shop.products)) return "shopify";
  const woo = await fetch(new URL("/wp-json/wc/store/v1/products?per_page=1", origin).toString(), { timeoutMs: 6000 });
  if (Array.isArray(json(woo))) return "woocommerce";
  // No answer from the data endpoints (a password store, a disabled API):
  // fall back to the theme's own assets, never to words in the copy.
  return hinted === "shopify" || hinted === "woocommerce" ? hinted : null;
}

/** Platform markers that only a store's own assets carry - not its text. */
const ASSET_PLATFORM: Array<[Exclude<Platform, null>, RegExp]> = [
  ["shopify", /cdn\.shopify\.com|\/cdn\/shop\/|window\.Shopify\s*=|shopify-section-/i],
  ["woocommerce", /wp-content\/plugins\/woocommerce|wc-blocks?[-_]|woocommerce-(?:layout|general|smallscreen)\.css|wc_add_to_cart_params/i],
];

/** The platform a home page's own assets show, or null. Copy that names a platform does not count. */
export function platformFromAssets(html: string): Platform {
  for (const [platform, re] of ASSET_PLATFORM) if (re.test(html)) return platform;
  return null;
}

const SHOPIFY_PAGE_SIZE = 250;
const SHOPIFY_MAX_PAGES = 4;
export const SHOPIFY_POLICY_PATHS = [
  "/policies/refund-policy",
  "/policies/shipping-policy",
  "/policies/terms-of-service",
  "/policies/privacy-policy",
  "/policies/contact-information",
];

export async function harvestShopify(origin: string, fetch: Fetcher = defaultFetcher): Promise<PlatformHarvest> {
  const products: any[] = [];
  let more = false;
  let unavailable: PlatformHarvest["feedUnavailable"];
  for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
    const r = await fetch(new URL(`/products.json?limit=${SHOPIFY_PAGE_SIZE}&page=${page}`, origin).toString());
    const body = json(r);
    if (!body || !Array.isArray(body.products)) {
      if (page === 1) unavailable = r && (r.status === 401 || r.status === 403 || r.status === 404) ? "disabled" : "unreadable";
      break;
    }
    products.push(...body.products);
    if (body.products.length < SHOPIFY_PAGE_SIZE) break;
    if (page === SHOPIFY_MAX_PAGES) more = true;
  }

  let summary: ProductsSummary | null = null;
  if (products.length) {
    const prices: number[] = [];
    let inStock = 0;
    for (const p of products) {
      const variants: any[] = Array.isArray(p.variants) ? p.variants : [];
      for (const v of variants) {
        const n = Number(v?.price);
        if (Number.isFinite(n) && n > 0) prices.push(n);
      }
      if (variants.some((v) => v?.available !== false)) inStock++;
    }
    summary = {
      count: products.length,
      more,
      categories: topCategories(products.map((p) => String(p.product_type ?? ""))),
      // The public feed carries no currency; the extraction step fills it from the page.
      priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices), currency: null } : null,
      inStock,
      highlights: products.slice(0, 8).map((p) => ({
        title: String(p.title ?? "").slice(0, 120),
        url: p.handle ? new URL(`/products/${p.handle}`, origin).toString() : null,
        price: Number.isFinite(Number(p.variants?.[0]?.price)) ? Number(p.variants[0].price) : null,
      })),
      source: "shopify_feed",
    };
  }
  return {
    platform: "shopify",
    products: summary,
    policyUrls: SHOPIFY_POLICY_PATHS.map((p) => new URL(p, origin).toString()),
    ...(unavailable ? { feedUnavailable: unavailable } : {}),
  };
}

const WOO_PAGE_SIZE = 100;
const WOO_MAX_PAGES = 5;

/**
 * `lang` is the site's own language (its home page's <html lang>). On a WPML
 * or Polylang store the Store API answers its default language unless asked
 * (Smoovee: English, though her customers read /he/); a store without them
 * ignores the parameter.
 */
export async function harvestWoo(origin: string, fetch: Fetcher = defaultFetcher, lang?: string): Promise<PlatformHarvest> {
  const products: any[] = [];
  let more = false;
  let unavailable: PlatformHarvest["feedUnavailable"];
  for (let page = 1; page <= WOO_MAX_PAGES; page++) {
    const langParam = lang && /^[a-z]{2}$/.test(lang) ? `&lang=${lang}` : "";
    const r = await fetch(new URL(`/wp-json/wc/store/v1/products?per_page=${WOO_PAGE_SIZE}&page=${page}${langParam}`, origin).toString());
    const body = json(r);
    if (!Array.isArray(body)) {
      if (page === 1) unavailable = r && (r.status === 401 || r.status === 403 || r.status === 404) ? "disabled" : "unreadable";
      break;
    }
    products.push(...body);
    if (body.length < WOO_PAGE_SIZE) break;
    if (page === WOO_MAX_PAGES) more = true;
  }

  let summary: ProductsSummary | null = null;
  if (products.length) {
    // Store API prices are integer minor units with their own exponent.
    const price = (p: any): number | null => {
      const raw = Number(p?.prices?.price);
      const unit = Number(p?.prices?.currency_minor_unit ?? 2);
      return Number.isFinite(raw) && raw > 0 ? raw / 10 ** unit : null;
    };
    const prices = products.map(price).filter((n): n is number => n !== null);
    summary = {
      count: products.length,
      more,
      // The Store API returns names as HTML ("Hoodies &amp; Sweatshirts"); they
      // are shown and taught as text.
      categories: topCategories(products.flatMap((p) => (Array.isArray(p.categories) ? p.categories.map((c: any) => decodeEntities(String(c?.name ?? ""))) : []))),
      priceRange: prices.length
        ? { min: Math.min(...prices), max: Math.max(...prices), currency: products.find((p) => p?.prices?.currency_code)?.prices?.currency_code ?? null }
        : null,
      inStock: products.filter((p) => p?.is_in_stock !== false).length,
      highlights: products.slice(0, 8).map((p) => ({
        title: decodeEntities(String(p.name ?? "")).slice(0, 120),
        url: typeof p.permalink === "string" ? p.permalink : null,
        price: price(p),
      })),
      ...(!more && products.length <= ITEMS_MAX
        ? {
            items: products.map((p) => ({
              title: decodeEntities(String(p.name ?? "")).slice(0, 160),
              url: typeof p.permalink === "string" ? p.permalink : null,
              price: price(p),
              categories: Array.isArray(p.categories) ? p.categories.map((c: any) => decodeEntities(String(c?.name ?? ""))).filter(Boolean) : [],
              details: plainDetails(p.short_description),
            })),
          }
        : {}),
      source: "woo_store_api",
    };
  }
  // Woo has no fixed policy paths; the sitemap and its keywords find them.
  return { platform: "woocommerce", products: summary, policyUrls: [], ...(unavailable ? { feedUnavailable: unavailable } : {}) };
}

export async function harvestPlatform(origin: string, platform: Platform, fetch: Fetcher = defaultFetcher, lang?: string): Promise<PlatformHarvest> {
  if (platform === "shopify") return harvestShopify(origin, fetch);
  if (platform === "woocommerce") return harvestWoo(origin, fetch, lang);
  return { platform: null, products: null, policyUrls: [] };
}
