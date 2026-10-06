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
] as const;
export type OAuthFailure = (typeof OAUTH_FAILURES)[number];

export function oauthFailure(code: string | undefined): OAuthFailure | 'other' | null {
  if (!code) return null;
  return (OAUTH_FAILURES as readonly string[]).includes(code) ? (code as OAuthFailure) : 'other';
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
