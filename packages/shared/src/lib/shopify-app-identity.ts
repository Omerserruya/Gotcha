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

import { resolveShopifyInstallUrl } from "./shopify-install";

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
   * The APP handle, used in every `admin.shopify.com` deep link - the app's
   * page in the merchant's admin, and the managed-pricing page at
   * `/store/<store>/charges/<appHandle>/pricing_plans`.
   *
   * This is NOT the App Store listing slug; see `installUrl`. The two were one
   * variable until review 132211 and are now `SHOPIFY_APP_PRICING_HANDLE` and
   * `SHOPIFY_APP_STORE_HANDLE`, both still falling back to the original
   * `SHOPIFY_APP_HANDLE` so an existing deployment is unaffected.
   *
   * Empty until read from the Partner Dashboard. Deliberately not defaulted: a
   * guessed handle produces a deep link that 404s in the merchant's admin,
   * which is worse than offering no link and saying so.
   */
  appHandle: string;
  extensionHandle: string;
  blockHandle: string;
  /**
   * The App Store listing the "Connect Shopify" button sends a merchant to,
   * where Shopify identifies or lets them pick the store. Derived from
   * `SHOPIFY_APP_STORE_HANDLE` (falling back to `SHOPIFY_APP_HANDLE`), and
   * deliberately NOT from `appHandle` above - see that field.
   *
   * Null until the handle is configured, and null is an ORDINARY state, not a
   * broken one:
   *
   *   • installation from the Partner Dashboard still works - Shopify calls
   *     `application_url` directly and the public install handler takes it
   *     from there;
   *   • OAuth, the callback, existing connections and reauthorization are all
   *     unaffected, because none of them reads this field.
   *
   * Only the in-app button depends on it, and it must say so plainly rather
   * than fall back to asking the merchant for their domain.
   */
  installUrl: string | null;
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
    appHandle:
      process.env.SHOPIFY_APP_PRICING_HANDLE?.trim() ||
      process.env.SHOPIFY_APP_HANDLE?.trim() ||
      "",
    extensionHandle: process.env.SHOPIFY_CHAT_EXTENSION_HANDLE || DEFAULT_EXTENSION_HANDLE,
    blockHandle: process.env.SHOPIFY_CHAT_BLOCK_HANDLE || DEFAULT_BLOCK_HANDLE,
    installUrl: resolveShopifyInstallUrl(process.env),
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
