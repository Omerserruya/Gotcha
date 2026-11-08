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
  const rules = !!html && hasRuleDiscountMarkers(html);
  storeRules.set(origin, { at: Date.now(), rules });
  console.log(`[woo-discount] store ${origin} rules=${rules}`);
  if (html) remember(sampleProductUrl, parseRenderedDiscount(html));
  return rules;
}

async function pageHtml(url: string): Promise<string | null> {
  try {
    const r: any = await safeFetch(url, { timeoutMs: 4000, maxBytes: 2_000_000, headers: { Accept: "text/html" } });
    return r?.ok && typeof r.text === "string" ? r.text : null;
  } catch { return null; }
}

function remember(productUrl: string, value: RenderedDiscount | null) {
  cache.set(productUrl, { at: Date.now(), value });
}

/** Read this product's page price when the store hides its discount from the API, or prices by rules. */
export async function discountFor(raw: any, productUrl: string): Promise<RenderedDiscount | null> {
  if (!productUrl) return null;
  if (!hiddenSale(raw) && !(await storeHasRuleDiscounts(productUrl).catch(() => false))) return null;
  return renderedDiscount(productUrl);
}

export async function renderedDiscount(productUrl: string): Promise<RenderedDiscount | null> {
  const hit = cache.get(productUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const html = await pageHtml(productUrl);
  const value: RenderedDiscount | null = html ? parseRenderedDiscount(html) : null;
  remember(productUrl, value);
  // One line per page read (not per cache hit): which product, what the page said.
  let path = productUrl;
  try { path = new URL(productUrl).pathname; } catch { /* keep the url */ }
  console.log(`[woo-discount] ${path.slice(0, 80)} ${value ? `was=${value.was} now=${value.now}` : "none"}`);
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
  return value;
}

/** A price as the store writes it ("170.30" stays, "262" stays). */
export const priceString = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
