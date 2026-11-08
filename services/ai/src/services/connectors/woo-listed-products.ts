/** Woo product listings kept briefly so a card needs no second read (no imports: any module may use it). */

/**
 * The products a list read just returned, by store and id, for two minutes
 * (Tehila 2026-11-02: a search, then get_product x2 and variations to build
 * the cards, each 22s on a slow moment of her host, and the turn ran out of
 * time before showing anything). A card for a product the store listed this
 * turn is built from that listing: the same object get_product returns.
 */
const listedProducts = new Map<string, { at: number; p: any }>();
const LISTED_TTL_MS = 2 * 60_000;
const storeKey = (storeUrl: string) => String(storeUrl ?? "").trim().toLowerCase().replace(/\/+$/, "");

export function rememberListed(url: string, out: unknown) {
  const m = /^(.*)\/wp-json\/wc\/v3\/products\?/.exec(url);
  if (!m || !Array.isArray(out)) return;
  const now = Date.now();
  for (const p of out) if (/^\d{1,12}$/.test(String(p?.id ?? "")) && p?.status) listedProducts.set(`${storeKey(m[1])}:${p.id}`, { at: now, p });
  if (listedProducts.size > 2000) for (const [k, v] of listedProducts) if (now - v.at > LISTED_TTL_MS) listedProducts.delete(k);
}

/**
 * The products a store's connection limits customers to (Smoovee 2026-11-08:
 * only "Shop Smoovee" can be ordered), as product ids: the store's own answer
 * to "which products are in these categories", because a WPML product's
 * categories list does not say (her Alexa lists only "מטבח" yet is one of
 * Shop Smoovee's 12). Set by the adapter on every call, so a listing read for
 * another purpose never becomes a card.
 */
const storeAllowed = new Map<string, Set<string>>();
export function setStoreAllowedProducts(storeUrl: string, ids: Set<string> | null) {
  if (ids) storeAllowed.set(storeKey(storeUrl), ids);
  else storeAllowed.delete(storeKey(storeUrl));
}
/** Does this store (its URL, or its wc/v3 base) limit customers to some products? */
export function wooStoreHasAllowList(storeOrBase: string): boolean {
  return storeAllowed.has(storeKey(String(storeOrBase ?? "").replace(/\/wp-json\/wc\/v3\/?$/, "")));
}
/** Is this product one the store's connection allows (any, when none is set)? */
export function wooProductAllowed(storeUrl: string, p: any): boolean {
  const ids = storeAllowed.get(storeKey(storeUrl));
  return !ids || ids.has(String(p?.id ?? ""));
}

/** A product this store listed in the last two minutes, or null (then read it). */
export function recentlyListedWooProduct(storeUrl: string, productId: string): any | null {
  const e = listedProducts.get(`${storeKey(storeUrl)}:${productId}`);
  return e && Date.now() - e.at < LISTED_TTL_MS && wooProductAllowed(storeUrl, e.p) ? e.p : null;
}

