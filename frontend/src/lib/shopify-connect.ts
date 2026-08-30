/**
 * Where the "Connect" button sends a merchant, for Shopify and everything else.
 *
 * Shopify is the one integration whose FIRST connection does not start with a
 * GOTCHA-issued authorize URL. The App Store requires the install to begin on
 * a Shopify-owned surface, and requirement 2.3.1 forbids asking the merchant
 * to type their `.myshopify.com` domain - so there is no shop parameter in
 * this file, and no code path that builds one.
 *
 * Three cases, and the distinction that matters is FIRST connect vs.
 * reauthorization:
 *
 *   not shopify            → the provider's authorize URL, as before.
 *   shopify, not connected → the Shopify install page. Shopify picks the store.
 *   shopify, connected     → reauthorization. The server reads the shop from
 *                            the stored connection, so this is still a plain
 *                            authorize URL and still needs no input from the
 *                            merchant.
 *
 * Lives here rather than inline because two components render this button
 * (Settings → Business Systems and the AI Studio marketplace). Inline, they
 * would drift, and the one that drifted back toward a `shop` parameter would
 * fail review rather than fail a test.
 */

import { initIntegrationOAuth, startShopifyInstall } from "./api";

export interface BeginConnectInput {
  token: string;
  slug: string;
  /** True when the tenant already holds a connection - i.e. reauthorization. */
  reauthorize?: boolean;
  /** Where the merchant was, so the callback returns them there. */
  flow?: string;
  /** Pre-OAuth fields for providers that need them (Salesforce, Square). */
  params?: Record<string, string>;
}

/**
 * The URL to navigate to. Navigate, do not open in a new tab: the install
 * start sets an HttpOnly cookie that must be present when Shopify redirects
 * the browser back.
 */
export async function beginConnect(input: BeginConnectInput): Promise<string> {
  const { token, slug, reauthorize, flow, params } = input;

  if (slug === "shopify" && !reauthorize) {
    const { url } = await startShopifyInstall(token, flow);
    return url;
  }

  // Shopify reauthorization sends no credentials: `params` may still hold
  // stale keys from a catalog row, and forwarding a `shop` would put the
  // typed-domain hole back through the side door.
  const extra =
    slug === "shopify"
      ? { ...(flow ? { flow } : {}) }
      : { ...(params || {}), ...(flow ? { flow } : {}) };

  const { url } = await initIntegrationOAuth(token, slug, extra);
  return url;
}

/**
 * What to tell the merchant above the button.
 *
 * Shopify's copy deliberately promises the store picker rather than describing
 * OAuth: "authorize access" is true of every provider here and answers none of
 * the question a merchant actually has, which is "how does it know which shop?"
 */
export function connectHelpText(slug: string, reauthorize: boolean): string {
  if (slug === "shopify") {
    return reauthorize
      ? "Re-authorize this store on Shopify. You will not need to enter anything."
      : "You'll select and authorize your store on Shopify.";
  }
  return reauthorize
    ? "Re-authorize this integration via OAuth. Required fields below are sent to the provider's authorize URL."
    : "This integration uses OAuth 2.0. Click below to authorize access.";
}

/** Button label. Shopify's says what happens, not which protocol does it. */
export function connectButtonLabel(slug: string, reauthorize: boolean): string {
  if (slug === "shopify") {
    return reauthorize ? "Re-authorize on Shopify" : "Connect Shopify";
  }
  return reauthorize ? "Re-authorize with OAuth" : "Connect with OAuth";
}

/**
 * A merchant-readable reason for a refused connect.
 *
 * `shopify_install_url_not_configured` is an OPERATOR problem, and saying so
 * plainly is the point: a merchant who reads "OAuth init failed - check
 * provider client ID/secret" will go looking in Shopify for something that is
 * missing in GOTCHA's environment.
 */
export function connectErrorMessage(slug: string, err: any): string {
  const code = err?.code || err?.message;
  if (code === "shopify_install_url_not_configured") {
    return "Shopify installs are not configured on this environment yet. Ask your GOTCHA administrator to set the Shopify install URL.";
  }
  if (code === "shopify_not_connected") {
    return "This workspace has no Shopify store yet - use Connect Shopify to install it.";
  }
  return err?.message || "Could not start the connection. Check the provider configuration on the server.";
}
