/**
 * Which systems connect at their provider AND come back here (backend
 * 381a5d1b's `redesign_studio` flow): HubSpot, Salesforce and Monday connect;
 * Shopify re-authorises the store already connected — a new store is
 * installed from Shopify, whose way back is still the previous app's.
 *
 * Stripe, Wix and Square carry no flow; Zoho and Google Calendar start from
 * the older OAuth routes. Those stay drawn, with why.
 */
export const OAUTH_HERE: Readonly<Record<string, 'connect' | 'reconnect'>> = {
  hubspot: 'connect',
  salesforce: 'connect',
  monday: 'connect',
  shopify: 'reconnect',
};

/** Can this system be (re)connected from here, given whether it is connected now? */
export function oauthHere(slug: string, connected: boolean): boolean {
  const mode = OAUTH_HERE[slug];
  return mode === 'connect' || (mode === 'reconnect' && connected);
}

/** The codes the return can carry — a closed set on the backend. */
export const OAUTH_FAILURES = [
  'denied',
  'token_exchange_failed',
  'catalog_missing',
  'callback_error',
  'validation_failed',
  'shop_connected_elsewhere',
  'link_failed',
] as const;
export type OAuthFailure = (typeof OAUTH_FAILURES)[number];

export function oauthFailure(code: string | undefined): OAuthFailure | 'other' | null {
  if (!code) return null;
  return (OAUTH_FAILURES as readonly string[]).includes(code) ? (code as OAuthFailure) : 'other';
}

/** Salesforce's two login hosts — the only extra the start takes. */
export const SALESFORCE_HOSTS = ['https://login.salesforce.com', 'https://test.salesforce.com'];
