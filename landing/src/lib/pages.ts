/**
 * The design addresses its 34 pages through `state.page` only - it never
 * touches the URL, so every page shares one address. This maps each of those
 * keys to a real path so the marketing site is linkable and indexable. The
 * rendered page for a given key is unchanged; only its address is new.
 */
export const PAGE_BY_PATH: Record<string, string> = {
  '': 'home',
  'pricing': 'pricing',
  'why-gotcha': 'why',
  'offer': 'offer',

  'about': 'co-about',
  'blog': 'co-blog',
  'careers': 'co-careers',
  'security': 'co-security',
  'contact': 'co-chat',

  // 'help' is deliberately absent. The Help Center is a real section with
  // category and article pages under src/app/help, not the design's single
  // placeholder hub, so /help is owned by that route rather than this map.

  'product/omnichannel': 'feat-omnichannel',
  'product/copilot': 'feat-copilot',
  'product/call-pilot': 'feat-callpilot',
  'product/knowledge-base': 'feat-knowledge',
  'product/approvals': 'feat-approvals',
  'product/customers': 'feat-customers',
  'product/ai-studio': 'feat-studio',
  'product/analytics': 'feat-analytics',
  'product/ai-employee': 'feat-employee',
  'product/channels': 'feat-channels',
  'product/integrations': 'feat-integrations',
  'product/social': 'feat-social',
  'product/store-widget': 'feat-widget',

  'solutions/cosmetics': 'sol-cosmetics',
  'solutions/fashion': 'sol-fashion',
  'solutions/home-and-furniture': 'sol-home',
  'solutions/clinics': 'sol-clinics',
  'solutions/restaurants': 'sol-food',
  'solutions/electronics': 'sol-electronics',
  'solutions/jewellery': 'sol-jewellery',
  'solutions/ecommerce': 'sol-ecommerce',
  'solutions/lead-handling': 'sol-leads',
  'solutions/running-it-alone': 'sol-owner',
  'solutions/front-line': 'sol-agent',
};

/**
 * Pages the design knows about that this app serves as a separate section
 * rather than as one of the landing's in-page views. Clicking one of these is
 * a real navigation, not a state change.
 */
export const EXTERNAL_PAGE: Record<string, string> = {
  // The design's help hub is a mockup - invented titles, invented counts. The
  // Help Center is a real section with categories and articles.
  'co-help': '/help',
};

export const PATH_BY_PAGE: Record<string, string> = Object.fromEntries(
  Object.entries(PAGE_BY_PATH).map(([path, page]) => [page, '/' + path]),
);

export const ALL_PATHS = Object.keys(PAGE_BY_PATH);

/**
 * The Hebrew half of every address.
 *
 * The design carries both languages in one bundle and switches them from the
 * footer, which is right for a canvas and leaves nothing to send: the whole
 * site was one address that happened to be in English when it loaded. So every
 * page has a second path under `/he`, prerendered in Hebrew, and the toggle
 * moves between the two rather than changing the page underneath an address
 * that no longer describes it.
 *
 * `/en` is deliberately NOT a second spelling of the same page. English is what
 * the bare path already is, and two URLs for one page is the problem this
 * solves rather than a feature of it.
 */
export const HE = 'he';

export type Lang = 'en' | 'he';

/** The address for a page, in a language. */
export function pathFor(page: string, lang: Lang): string {
  const path = PATH_BY_PAGE[page];
  if (!path) return lang === HE ? `/${HE}` : '/';
  if (lang !== HE) return path;
  return path === '/' ? `/${HE}` : `/${HE}${path}`;
}

/** The page and language an address names, or null when it is not the landing's. */
export function parsePath(pathname: string): { page: string; lang: Lang } | null {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  const he = trimmed === HE || trimmed.startsWith(`${HE}/`);
  const rest = he ? trimmed.slice(HE.length).replace(/^\/+/, '') : trimmed;
  const page = PAGE_BY_PATH[rest];
  return page ? { page, lang: he ? HE : 'en' } : null;
}

/** Every address the landing serves, in both languages. */
export const ALL_LOCALISED_PATHS: string[] = [
  ...ALL_PATHS,
  ...ALL_PATHS.map((p) => (p === '' ? HE : `${HE}/${p}`)),
];
