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
 *   shopify, not connected → the App Store listing. Shopify picks the store.
 *                            Before the listing publishes there is no such
 *                            page, and the server answers
 *                            `shopify_install_not_available`; the merchant is
 *                            told to wait, never asked for their domain.
 *   shopify, connected     → reauthorization. The server reads the shop from
 *                            the stored connection, so this is still a plain
 *                            authorize URL and still needs no input from the
 *                            merchant. This path does NOT depend on the
 *                            listing and keeps working today.
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
 * The default message is written for an operator ("check the provider
 * configuration on the server") and is wrong to show a merchant for the two
 * Shopify cases below - a merchant who reads it goes looking inside Shopify
 * for something that is not there.
 */
export function connectErrorMessage(slug: string, err: any): string {
  const code = err?.code || err?.message;
  if (code === "shopify_install_not_available") {
    // TEMPORARY STATE, said plainly. The App Store listing is not published
    // yet, so there is no Shopify page to send the merchant to.
    //
    // Note what this message does NOT do: offer a shop-domain box. Falling
    // back to "just type your store address" is exactly the flow App Store
    // requirement 2.3.1 forbids, and a fallback added "only until the listing
    // is live" is one nobody removes afterwards. A merchant who cannot
    // self-serve today is a support conversation; a merchant who typed their
    // domain is a rejected submission.
    return "New Shopify connections aren't available just yet - our Shopify App Store listing is still being published. Contact support and we'll connect your store for you.";
  }
  if (code === "shopify_not_connected") {
    return "This workspace has no Shopify store yet - use Connect Shopify to install it.";
  }
  return err?.message || "Could not start the connection. Check the provider configuration on the server.";
}
