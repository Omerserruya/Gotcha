/**
 * The pages drawn from the v8 design ("GOTCHA Website.dc.html"), and nothing
 * else: one list for the routes, the links between the two designs, the older
 * site's navigation and the lead sources.
 *
 * Each keeps the address the older design gave it (pages.ts), so nothing a
 * search engine or a link knows about moves. `page` is the design's own name
 * for the branch (its ?page= value); `key` is the older design's page key.
 */
export type V8Page = 'home' | 'talk' | 'why' | 'offer' | 'pricing' | 'ecommerce' | 'leads';

export const V8_PAGES: Record<V8Page, { key: string; source: string | null }> = {
  home: { key: 'home', source: null },
  talk: { key: 'co-chat', source: 'landing-contact' },
  why: { key: 'why', source: 'landing-why' },
  offer: { key: 'offer', source: 'landing-offer' },
  pricing: { key: 'pricing', source: 'landing-pricing' },
  ecommerce: { key: 'sol-ecommerce', source: 'landing-ecommerce' },
  leads: { key: 'sol-leads', source: 'landing-leads' },
};

/** Older-design page key -> the v8 page that now draws it. */
export const V8_PAGE_BY_KEY: Record<string, V8Page> = Object.fromEntries(
  (Object.keys(V8_PAGES) as V8Page[]).map((p) => [V8_PAGES[p].key, p]),
);
