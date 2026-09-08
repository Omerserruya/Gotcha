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
  'help': 'co-help',
  'contact': 'co-chat',

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

export const PATH_BY_PAGE: Record<string, string> = Object.fromEntries(
  Object.entries(PAGE_BY_PATH).map(([path, page]) => [page, '/' + path]),
);

export const ALL_PATHS = Object.keys(PAGE_BY_PATH);
