/**
 * A store discount the API does not carry (Smoovee prod 2026-11-08): the
 * "Discount Rules for WooCommerce" plugin (Flycart, awdr) prices at render
 * time, so the REST product says price = regular = sale = 262 with
 * on_sale:true, while the product page shows ₪262 struck through and ₪170.30.
 * The bot carded 262 and said nothing of the discount.
 *
 * For a product the store marks on sale whose prices show no difference, the
 * product page's own main price block is read: `<p class="price"><del>…262…
 * </del><ins>…170.30…</ins></p>`. Ten minutes per page, a short timeout, only
 * for the few products being shown, and only the store's own product link.
 * No difference found: null, and the API's price stands (never a guess).
 *
 * A page that could not be READ is not a page with no discount (Smoovee prod
 * 2026-11-14 21:26: five product pages read at once all timed out at 4 s, were
 * logged and cached as "none", and a customer was quoted the full ₪219 to ₪252
 * during a store-wide 37% sale). A failed read is "unknown", it is never
 * cached, and on a store that prices by rules the caller shows no number.
 */
import { safeFetch } from "@chatcenter/shared";

export interface RenderedDiscount { was: number; now: number }

const cache = new Map<string, { at: number; value: RenderedDiscount | null }>();
const TTL_MS = 10 * 60_000;

/** Does the API mark it on sale while showing no lower price (the plugin's case)? */
export function hiddenSale(raw: any): boolean {
  if (raw?.on_sale !== true) return false;
  const reg = String(raw?.regular_price ?? "").trim(), sale = String(raw?.sale_price ?? "").trim();
  return !sale || sale === reg;
}

const amount = (html: string): number | null => {
  const m = /<bdi[^>]*>([\s\S]*?)<\/bdi>/i.exec(html) ?? /amount[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  if (!m) return null;
  const n = Number(m[1].replace(/<[^>]*>/g, "").replace(/&#?\w+;/g, "").replace(/[^\d.,]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The page's main price block, the first one: was (del) and now (ins); null unless now < was. */
export function parseRenderedDiscount(html: string): RenderedDiscount | null {
  const block = /<p[^>]*class="[^"]*\bprice\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1];
  if (!block) return null;
  const del = /<del[^>]*>([\s\S]*?)<\/del>/i.exec(block)?.[1];
  const ins = /<ins[^>]*>([\s\S]*?)<\/ins>/i.exec(block)?.[1];
  if (!del || !ins) return null;
  const was = amount(del), now = amount(ins);
  return was != null && now != null && now < was ? { was, now } : null;
}

/** A page of a store that prices by rules at render time (Flycart "Discount Rules for WooCommerce"). */
export function hasRuleDiscountMarkers(html: string): boolean {
  return /awdr[_-]|\bwdr[_-]|woo-discount-rules|advanced-woo-discount-rules/i.test(html);
}

const storeRules = new Map<string, { at: number; rules: boolean }>();
const STORE_TTL_MS = 24 * 60 * 60_000;
const originOf = (u: string) => { try { return new URL(u).origin.toLowerCase(); } catch { return ""; } };

/**
 * Does this store price by rules? Smoovee prod 2026-11-08: through wc/v3 her
 * products say on_sale:false (sale_price is empty), so the on-sale trigger
 * never fired. Read once per store per day from one product page (which also
 * fills that page's price), then every shown product of a rules store has its
 * page price read; a store without the plugin makes no further page reads.
 */
export async function storeHasRuleDiscounts(sampleProductUrl: string): Promise<boolean> {
  const origin = originOf(sampleProductUrl);
  if (!origin) return false;
  const hit = storeRules.get(origin);
  if (hit && Date.now() - hit.at < STORE_TTL_MS) return hit.rules;
  const html = await pageHtml(sampleProductUrl);
  // Unreadable: not "no rules". A store already known to use rules keeps that.
  if (!html) {
    console.log(`[woo-discount] store ${origin} rules=unknown (page read failed)`);
    return hit?.rules ?? false;
  }
  const rules = hasRuleDiscountMarkers(html);
  storeRules.set(origin, { at: Date.now(), rules });
  console.log(`[woo-discount] store ${origin} rules=${rules}`);
  remember(sampleProductUrl, parseRenderedDiscount(html));
  return rules;
}

/** Known (within a day) to price by rules: its API prices are not what a buyer pays. */
export function storeKnownToUseRules(productUrl: string): boolean {
  const hit = storeRules.get(originOf(productUrl));
  return !!hit && hit.rules;
}

/** Per read; a store's uncached page renders in PHP and can take seconds. */
export const PAGE_TIMEOUT_MS = 8000;
/** At most this many page reads at once per store (five at once all timed out). */
export const PAGE_CONCURRENCY = 2;

const running = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

async function withStoreSlot<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const origin = originOf(url) || url;
  if ((running.get(origin) ?? 0) >= PAGE_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      const q = waiting.get(origin) ?? [];
      q.push(resolve);
      waiting.set(origin, q);
    });
  }
  running.set(origin, (running.get(origin) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    running.set(origin, (running.get(origin) ?? 1) - 1);
    const next = waiting.get(origin)?.shift();
    if (next) next();
  }
}

async function fetchOnce(url: string): Promise<string | null> {
  try {
    const r: any = await safeFetch(url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: 2_000_000, headers: { Accept: "text/html" } });
    return r?.ok && typeof r.text === "string" ? r.text : null;
  } catch { return null; }
}

/** The page, or null when it could not be read (timeout, error, not 2xx), after one retry. */
async function pageHtml(url: string): Promise<string | null> {
  return withStoreSlot(url, async () => (await fetchOnce(url)) ?? (await fetchOnce(url)));
}

function remember(productUrl: string, value: RenderedDiscount | null) {
  cache.set(productUrl, { at: Date.now(), value });
}

/**
 * What the product's page says about its price:
 *   - "discount": the page sells it below the API price (was / now);
 *   - "none": the page was read and shows no discount, or the store does not
 *     price by rules: the API price is the price;
 *   - "unknown": the page could not be read on a store whose prices are set
 *     at render time. The API price may be wrong: show no number.
 */
export type PagePrice =
  | { state: "discount"; discount: RenderedDiscount }
  | { state: "none" }
  | { state: "unknown" };

export async function pagePriceFor(raw: any, productUrl: string): Promise<PagePrice> {
  if (!productUrl) return { state: "none" };
  const hidden = hiddenSale(raw);
  if (!hidden && !(await storeHasRuleDiscounts(productUrl).catch(() => false))) return { state: "none" };
  const d = await readPage(productUrl);
  if (d === undefined) return hidden || storeKnownToUseRules(productUrl) ? { state: "unknown" } : { state: "none" };
  return d ? { state: "discount", discount: d } : { state: "none" };
}

/** Read this product's page price when the store hides its discount from the API, or prices by rules. */
export async function discountFor(raw: any, productUrl: string): Promise<RenderedDiscount | null> {
  const p = await pagePriceFor(raw, productUrl);
  return p.state === "discount" ? p.discount : null;
}

export async function renderedDiscount(productUrl: string): Promise<RenderedDiscount | null> {
  return (await readPage(productUrl)) ?? null;
}

/** The page's discount, null for none, undefined when the page could not be read (never cached). */
async function readPage(productUrl: string): Promise<RenderedDiscount | null | undefined> {
  const hit = cache.get(productUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const html = await pageHtml(productUrl);
  // One line per page read (not per cache hit): which product, what the page said.
  let path = productUrl;
  try { path = new URL(productUrl).pathname; } catch { /* keep the url */ }
  if (!html) {
    console.log(`[woo-discount] ${path.slice(0, 80)} fail`);
    return undefined;
  }
  const value = parseRenderedDiscount(html);
  remember(productUrl, value);
  console.log(`[woo-discount] ${path.slice(0, 80)} ${value ? `was=${value.was} now=${value.now}` : "none"}`);
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
  return value;
}

/**
 * The whole percent a rule took off (262 → 170.30: 35), when it is one: the
 * same percent then holds on the product's other variants. null for a cut that
 * is not a whole percent (a fixed amount off), which says nothing of them.
 */
export function wholePercentOff(was: number, now: number): number | null {
  if (!(was > 0) || !(now > 0) || now >= was) return null;
  const off = Math.round((1 - now / was) * 100);
  return off > 0 && off < 100 && Math.abs(Math.round(was * (100 - off)) / 100 - now) < 0.011 ? off : null;
}

/** A price as the store writes it ("170.30" stays, "262" stays). */
export const priceString = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
