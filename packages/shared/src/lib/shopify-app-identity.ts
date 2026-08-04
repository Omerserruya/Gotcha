/**
 * The ONE Shopify app identity.
 *
 * GOTCHA used to run two Partner apps: Core held the Admin token and every
 * commerce scope, Chat owned the Theme App Extension and had a second client
 * id, a second secret and a second OAuth install. That split was justified by
 * scope minimization - Chat was meant to hold `read_products` and nothing
 * else - but the Chat app ended up declaring `scopes = ""` and holding no
 * Admin token at all, which left nothing to minimize and two identities to
 * keep in step.
 *
 * This module replaces `getShopifyChatAppConfig()`. It is deliberately NOT an
 * alias: pointing `SHOPIFY_CHAT_APP_SECRET` at the Core secret would leave two
 * environment names for one value, and the first rotation that missed one of
 * them would break app-proxy verification with a signature error that reads
 * exactly like a misconfigured proxy. One name, one secret.
 *
 * Everything the storefront needs is derived from the Core app:
 *   • app-proxy signatures are made with the Core secret
 *   • webhook HMACs are verified with the Core secret
 *   • the Theme Editor deep link is built from the Core client id
 */

/** Theme App Extension directory handle. Not the block handle. */
const DEFAULT_EXTENSION_HANDLE = "gotcha-chat";
/**
 * App Embed BLOCK handle - the `.liquid` filename, underscores and all.
 * Shopify's Theme Editor deep link wants the BLOCK, not the extension.
 * Getting this wrong opens the editor with nothing selected, which reads to
 * a merchant as "the link is broken".
 */
const DEFAULT_BLOCK_HANDLE = "gotcha_chat";

export interface ShopifyAppIdentity {
  /** Core app client id (`SHOPIFY_API_KEY`). Public; appears in OAuth URLs. */
  clientId: string;
  /** Core app secret. Signs app-proxy requests and webhook HMACs. */
  clientSecret: string;
  /** Public merchant-facing base URL. */
  appUrl: string;
  /** Absolute OAuth callback; must match the Partner Dashboard exactly. */
  redirectUri: string;
  /**
   * App handle for admin deep links.
   *
   * Empty until read from the Partner Dashboard and recorded as
   * SHOPIFY_APP_HANDLE. Deliberately not defaulted: a guessed handle produces
   * a deep link that 404s in the merchant's admin, which is worse than
   * offering no link and saying so.
   */
  appHandle: string;
  extensionHandle: string;
  blockHandle: string;
}

export function getShopifyAppIdentity(): ShopifyAppIdentity {
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI || "";
  // The app URL is the origin of the callback unless stated explicitly, so a
  // correct callback cannot coexist with a wrong app URL.
  let appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  if (!appUrl && redirectUri) {
    try {
      appUrl = new URL(redirectUri).origin;
    } catch {
      appUrl = "";
    }
  }
  return {
    clientId: process.env.SHOPIFY_API_KEY || "",
    clientSecret: process.env.SHOPIFY_API_SECRET || "",
    appUrl,
    redirectUri,
    appHandle: process.env.SHOPIFY_APP_HANDLE || "",
    extensionHandle: process.env.SHOPIFY_CHAT_EXTENSION_HANDLE || DEFAULT_EXTENSION_HANDLE,
    blockHandle: process.env.SHOPIFY_CHAT_BLOCK_HANDLE || DEFAULT_BLOCK_HANDLE,
  };
}

export interface AppIdentityProblem {
  key: string;
  detail: string;
}

/**
 * Everything missing that would make the storefront surface fail. Empty = ready.
 *
 * Returns problems rather than throwing: an unconfigured deployment must boot
 * and report "not configured" on the routes that need it, instead of taking
 * the whole AI service down.
 */
export function validateAppIdentity(cfg = getShopifyAppIdentity()): AppIdentityProblem[] {
  const problems: AppIdentityProblem[] = [];
  if (!cfg.clientId) {
    problems.push({ key: "SHOPIFY_API_KEY", detail: "Shopify app client id is not set." });
  }
  if (!cfg.clientSecret) {
    problems.push({
      key: "SHOPIFY_API_SECRET",
      detail: "Shopify app secret is not set - app-proxy and webhook verification will refuse every request.",
    });
  }
  if (!cfg.appUrl) {
    problems.push({ key: "SHOPIFY_APP_URL", detail: "Public app URL is not set and could not be derived." });
  }
  return problems;
}

export function isAppIdentityConfigured(cfg = getShopifyAppIdentity()): boolean {
  return validateAppIdentity(cfg).length === 0;
}
