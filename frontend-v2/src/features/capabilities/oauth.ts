/**
 * Which systems connect at their provider AND come back here (backend
 * 381a5d1b's `redesign_studio` flow): HubSpot, Salesforce and Monday connect;
 * Shopify re-authorises the store already connected - a new store is
 * installed from Shopify, whose way back is still the previous app's.
 *
 * Wix and Square carry no flow yet: drawn, with why. Stripe, Zoho, Google
 * Calendar and Calendly are live (backend e7523379); WooCommerce connects
 * through its own store-address form (`WooConnect`).
 */
export const OAUTH_HERE: Readonly<Record<string, 'connect' | 'reconnect'>> = {
  hubspot: 'connect',
  salesforce: 'connect',
  monday: 'connect',
  shopify: 'reconnect',
  // Backend e7523379: JSON `{ url }`, landing on this screen.
  stripe: 'connect',
  zoho_crm: 'connect',
  google_calendar: 'connect',
  calendly: 'connect',
};

/** Can this system be (re)connected from here, given whether it is connected now? */
export function oauthHere(slug: string, connected: boolean): boolean {
  const mode = OAUTH_HERE[slug];
  return mode === 'connect' || (mode === 'reconnect' && connected);
}

/** The codes the return can carry - a closed set on the backend. */
export const OAUTH_FAILURES = [
  'denied',
  'token_exchange_failed',
  'catalog_missing',
  'callback_error',
  'validation_failed',
  'shop_connected_elsewhere',
  'link_failed',
  // e7523379 and B (WooCommerce):
  'not_configured',
  'insufficient_permissions',
  'callback_not_received',
  'invalid_state',
  // Shopify's refused install (shopify-install.ts), when it lands here.
  'invalid_request',
] as const;
export type OAuthFailure = (typeof OAUTH_FAILURES)[number];

export function oauthFailure(code: string | undefined): OAuthFailure | 'other' | null {
  if (!code) return null;
  return (OAUTH_FAILURES as readonly string[]).includes(code) ? (code as OAuthFailure) : 'other';
}

/**
 * Shopify's refused install, as `shopify-install.ts` (`installErrorRedirect`)
 * and the callback's `shop_taken` name it - a closed set. It lands on
 * `/settings/business-systems?shopify_install_error=<code>`, which nginx sends
 * to `/v2/settings/systems`; the backend is moving it to this screen as
 * `?system=shopify&error=<code>`, where `oauthFailure` reads the same codes.
 */
export const SHOPIFY_INSTALL_ERRORS = [
  'invalid_request',
  'not_configured',
  'shop_connected_elsewhere',
] as const;
export type ShopifyInstallError = (typeof SHOPIFY_INSTALL_ERRORS)[number];

/** A code we name, or `other` - said generically, never printed. */
export function shopifyInstallError(
  code: string | undefined,
): ShopifyInstallError | 'other' | null {
  if (!code) return null;
  return (SHOPIFY_INSTALL_ERRORS as readonly string[]).includes(code)
    ? (code as ShopifyInstallError)
    : 'other';
}

/**
 * Can this system be disconnected from here?
 *
 *   `calendar` - it books through a per-employee `CalendarAccount`, which
 *                neither disconnect route touches.
 *
 * Shopify is (ai 9d583f03): the route stops the storefront chat and releases
 * the store, locally - the app stays installed and Shopify keeps billing
 * until the merchant removes it in their admin, which the confirm says.
 */
export function disconnectHere(slug: string): 'here' | 'calendar' {
  if (slug === 'google_calendar' || slug === 'calendly') return 'calendar';
  return 'here';
}

/** Salesforce's two login hosts - the only extra the start takes. */
export const SALESFORCE_HOSTS = ['https://login.salesforce.com', 'https://test.salesforce.com'];

/** The store address, as WooCommerce's approval needs it: https (http only outside production). */
export function storeAddressOf(raw: string, production: boolean): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) return null;
  if (!url.hostname.includes('.') || url.username || url.password) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}
