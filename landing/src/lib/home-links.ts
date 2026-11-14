/**
 * Where the v8 home's links go.
 *
 * The design keeps every page on one URL and links them as `?page=<key>&lang=`,
 * pointing the pages it has not redrawn at the previous export by the same
 * keys. This site already gives each of those keys a real address
 * (`pages.ts`), so a key resolves to that address in the reader's language.
 *
 * A key with no page on this site - the design names a few that were never
 * built - stays on the home, as the design's own placeholders do.
 */
import { EXTERNAL_PAGE, PATH_BY_PAGE, pathFor, type Lang } from '@/lib/pages';
import { links } from '@/lib/site';
import { PORT_LINK_PAGES } from '@/generated/home/port-links';
import { V8_PAGES, V8_PAGE_BY_KEY, type V8Page } from '@/lib/v8-pages';

/** Keys the design links to that this site has no page for. Listed, not guessed. */
export const NO_PAGE = new Set(['feat-broadcast', 'feat-cart']);

/**
 * `current` is the v8 page being drawn: a link to it is #top, as the design
 * writes it (its pageUrl() answers '#top' for the page it is on).
 */
export function homeHref(page: string | null | undefined, lang: Lang, current: string = 'home'): string {
  if (!page || NO_PAGE.has(page)) return '#top';
  if (V8_PAGE_BY_KEY[page] === (current || 'home')) return '#top';
  if (page === 'home') return pathFor('home', lang);
  if (page === 'help' || EXTERNAL_PAGE[page] === '/help') return links.help(lang === 'he' ? '/he' : '');
  if (page.startsWith('legal:')) {
    // The Trust Center's Hebrew documents live under /legal/he/<slug>.
    const url = links.trust(page.slice('legal:'.length));
    return lang === 'he' ? url.replace('/legal/', '/legal/he/') : url;
  }
  if (PATH_BY_PAGE[page] === undefined) {
    throw new Error(`home link: no address for page "${page}"`);
  }
  return pathFor(page, lang);
}

/** The same v8 page in the other language: what the EN / עברית switch opens. */
export function v8PageHref(page: string | undefined, lang: Lang): string {
  const v8 = (page || 'home') as V8Page;
  if (!V8_PAGES[v8]) throw new Error(`v8 page: unknown page "${page}"`);
  return pathFor(V8_PAGES[v8].key, lang);
}

/** The bindings the compiler put where the design had `href="#top"`. */
export function portLinks(lang: Lang): Record<string, string> {
  const out: Record<string, string> = { login: links.app() };
  for (const [key, page] of Object.entries(PORT_LINK_PAGES as Record<string, string>)) {
    out[key] = homeHref(page, lang);
  }
  return out;
}
