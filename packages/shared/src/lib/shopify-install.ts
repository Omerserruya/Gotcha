/**
 * Shopify app entry + install security.
 *
 * This module owns the ONE thing that must be right about a Shopify-owned
 * installation: deciding whether an inbound request really came from Shopify,
 * before anything else happens.
 *
 * Why it exists as its own module
 * -------------------------------
 * The old flow started OAuth from a GOTCHA screen where the merchant TYPED
 * their `.myshopify.com` domain. That is rejected by App Store review
 * (requirement 2.3.1), but the deeper problem is that a typed shop is an
 * unauthenticated claim: whatever the merchant pasted became the host we then
 * redirected the browser to. The install entry point below inverts that -
 * the shop arrives INSIDE a request Shopify signed, and nothing acts on it
 * until the signature verifies.
 *
 * Three HMAC schemes exist in this integration and they are NOT
 * interchangeable (see shopify-app-proxy.ts for the full table). App entry
 * and the OAuth callback both use the query-string scheme:
 *
 *     sorted params except `hmac`/`signature`, joined "k=v" with "&",
 *     HMAC-SHA256, hex.
 *
 * That function already exists as `verifyShopifyQueryHmac` in
 * shopify-chat-app.ts and is deliberately REUSED here rather than
 * reimplemented. A second copy of signature logic is how the two drift and
 * one of them silently stops rejecting anything.
 */

import { verifyShopifyQueryHmac } from "./shopify-chat-app";

/**
 * How far out of date a signed app-entry request may be.
 *
 * Shopify's own guidance is to reject stale requests; the exact bound is
 * ours. 300s is wide enough to survive ordinary clock skew between Shopify
 * and this host, and narrow enough that a captured URL is useless by the
 * time it reaches a log reader. Replay INSIDE the window is separately
 * closed by the single-use OAuth state, so this bound is defence in depth
 * rather than the only guard.
 */
export const APP_ENTRY_MAX_AGE_SECONDS = 300;

/** Canonical `<slug>.myshopify.com`. No auto-completion - see below. */
const STRICT_SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * The shop domain, accepted ONLY in the exact form Shopify sends it.
 *
 * Deliberately NOT `normalizeShopifyShopDomain`. That helper is forgiving by
 * design - it strips a scheme, strips a path, and appends `.myshopify.com`
 * to a bare slug - because it was built for values a human typed into a
 * form. Every one of those affordances is a liability on a signed request:
 *
 *   • `evil` would be completed to `evil.myshopify.com`, inventing a host
 *     Shopify never named.
 *   • `https://evil.com/x` would be reduced to `evil.com` and then to
 *     `evil.com.myshopify.com`, quietly turning a rejected input into an
 *     accepted-looking one.
 *
 * Shopify always sends the full canonical host, so requiring it costs
 * nothing and removes the entire class. The forgiving helper stays where it
 * belongs: normalizing values we already trust (a stored config, a webhook
 * payload we verified).
 */
export function strictShopDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > 255) return null;
  if (!STRICT_SHOP_RE.test(raw)) return null;
  // Reject the bare suffix and any embedded dot in the slug: `a.b.myshopify.com`
  // is not a shop, and `myshopify.com` is not one either.
  const slug = raw.slice(0, -".myshopify.com".length);
  if (!slug || slug.includes(".")) return null;
  return raw;
}

/**
 * Exactly one value for a query key, or null.
 *
 * Express turns `?shop=a&shop=b` into an array. Shopify never repeats a
 * parameter, so a repeat is either a proxy artefact or someone probing for a
 * parser disagreement between our HMAC input and our shop check. Both are
 * answered the same way: refuse.
 */
export function singleValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  return null;
}

/** Whether a Shopify `timestamp` (seconds since epoch, as a string) is fresh. */
export function isFreshAppEntryTimestamp(
  raw: unknown,
  now: Date = new Date(),
  maxAgeSeconds: number = APP_ENTRY_MAX_AGE_SECONDS,
): boolean {
  const value = singleValue(raw);
  if (!value || !/^\d{1,15}$/.test(value)) return false;
  const ts = Number(value);
  if (!Number.isFinite(ts)) return false;
  const deltaSeconds = Math.abs(Math.floor(now.getTime() / 1000) - ts);
  return deltaSeconds <= maxAgeSeconds;
}

export type AppEntryRejection =
  | "shop_missing"
  | "shop_invalid"
  | "hmac_missing"
  | "hmac_invalid"
  | "timestamp_missing"
  | "timestamp_stale"
  | "not_configured";

export type AppEntryResult =
  | { ok: true; shop: string }
  | { ok: false; reason: AppEntryRejection };

/**
 * Validate a signed Shopify app-entry (installation) request.
 *
 * Order matters, and it is cheapest-and-most-specific first EXCEPT that the
 * signature is checked before anything is done with the shop. The shop is
 * SHAPE-checked first only so a malformed host never reaches the redirect
 * builder even if a secret is misconfigured; nothing is acted on until the
 * HMAC verifies.
 *
 * Returns a reason rather than throwing so the caller can log precisely and
 * answer the browser vaguely - a forged signature and a stale timestamp must
 * be distinguishable in our logs and identical to a prober.
 *
 * `query` is the raw parsed query string. It is passed to the HMAC verifier
 * UNMODIFIED: Shopify signed every parameter it sent (including `host`,
 * `embedded`, `session` and anything added later), so dropping or reordering
 * keys here would compute a digest over a different message than the one
 * that was signed.
 */
export function verifyAppEntryHmac(
  query: Record<string, unknown>,
  secret: string,
  opts: { now?: Date; maxAgeSeconds?: number } = {},
): AppEntryResult {
  if (!secret) return { ok: false, reason: "not_configured" };

  const rawShop = query.shop;
  if (rawShop === undefined || rawShop === null || rawShop === "") {
    return { ok: false, reason: "shop_missing" };
  }
  // A repeated `shop` is an array here; `strictShopDomain` refuses non-strings,
  // so duplicates fall out as `shop_invalid` without a special case.
  const shop = strictShopDomain(singleValue(rawShop));
  if (!shop) return { ok: false, reason: "shop_invalid" };

  const hmac = singleValue(query.hmac);
  if (!hmac) return { ok: false, reason: "hmac_missing" };
  // Shopify sends lowercase hex. Anything else is not a digest we produce.
  if (!/^[a-f0-9]{64}$/i.test(hmac)) return { ok: false, reason: "hmac_invalid" };

  const timestamp = singleValue(query.timestamp);
  if (!timestamp) return { ok: false, reason: "timestamp_missing" };

  // Signature BEFORE freshness: the timestamp is part of the signed message,
  // so trusting it to decide anything before verifying the signature would be
  // acting on an attacker-chosen value.
  if (!verifyShopifyQueryHmac(query, secret)) {
    return { ok: false, reason: "hmac_invalid" };
  }

  if (!isFreshAppEntryTimestamp(timestamp, opts.now, opts.maxAgeSeconds)) {
    return { ok: false, reason: "timestamp_stale" };
  }

  return { ok: true, shop };
}

/**
 * Verify an OAuth CALLBACK's `hmac`.
 *
 * Same scheme as app entry and the same reuse rule, but a separate entry
 * point because the two have different required parameters: a callback
 * carries `code` and `state`, and Shopify does not always include a
 * `timestamp`. Requiring one here would reject legitimate callbacks; replay
 * is closed by the single-use state instead, which is the stronger guard.
 */
export function verifyOAuthCallbackHmac(
  query: Record<string, unknown>,
  secret: string,
): AppEntryResult {
  if (!secret) return { ok: false, reason: "not_configured" };

  const shop = strictShopDomain(singleValue(query.shop));
  if (!shop) return { ok: false, reason: query.shop ? "shop_invalid" : "shop_missing" };

  const hmac = singleValue(query.hmac);
  if (!hmac) return { ok: false, reason: "hmac_missing" };
  if (!/^[a-f0-9]{64}$/i.test(hmac)) return { ok: false, reason: "hmac_invalid" };

  if (!verifyShopifyQueryHmac(query, secret)) {
    return { ok: false, reason: "hmac_invalid" };
  }
  return { ok: true, shop };
}

// ─── Redirect construction ───────────────────────────────────

/**
 * The Shopify authorization URL for a shop we have already VERIFIED.
 *
 * Takes the shop as a separate, validated argument rather than reading it
 * from a request, so there is no path by which a browser-supplied host
 * reaches `Location:`. `shop` is re-checked here anyway: this function is the
 * last thing between validation and an outbound redirect, and a caller that
 * forgets is a bug that should fail closed rather than emit an open redirect.
 */
export function buildShopifyAuthorizeUrl(input: {
  shop: string;
  clientId: string;
  scopes: string;
  redirectUri: string;
  state: string;
}): string | null {
  const shop = strictShopDomain(input.shop);
  if (!shop || !input.clientId || !input.redirectUri || !input.state) return null;
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: input.scopes,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Shopify uses the word "handle" for more than one identifier, and they are
 * not guaranteed to be the same string. Two of them reach merchants:
 *
 *   SHOPIFY_APP_STORE_HANDLE   the App Store LISTING slug. Only ever appears
 *                              in `https://apps.shopify.com/<handle>`.
 *   SHOPIFY_APP_PRICING_HANDLE the APP handle, which appears in admin deep
 *                              links such as the managed-pricing page
 *                              `/store/<store>/charges/<handle>/pricing_plans`.
 *
 * They were one variable until App Store review 132211, and that coupling was
 * itself the defect. The pricing handle was known and correct, the listing
 * handle was not known, and because a single variable fed both, the only way
 * to keep the pricing URL right was to leave the variable empty - which
 * silently disabled the "Connect Shopify" button and produced the
 * "not available yet" screen the reviewer hit. Splitting them means an
 * unknown listing handle can no longer switch off a working pricing URL, or
 * the reverse.
 *
 * `SHOPIFY_APP_HANDLE` stays readable as a fallback for both so an existing
 * deployment keeps working across this change.
 */
function readHandle(raw: string | undefined): string | null {
  const handle = (raw || "").trim();
  // Shopify handles are lowercase alphanumeric with hyphens. Anything else was
  // not copied from the dashboard, and building a URL from it would send a
  // merchant to a 404 with no way to tell why.
  if (!handle || !/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
  return handle;
}

/** The App Store listing slug, or null when it has not been configured. */
export function resolveShopifyAppStoreHandle(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readHandle(env.SHOPIFY_APP_STORE_HANDLE) ?? readHandle(env.SHOPIFY_APP_HANDLE);
}

/**
 * Where the merchant-facing "Connect Shopify" button sends a merchant.
 *
 * PUBLIC DISTRIBUTION ONLY. For a public app there is exactly one
 * Shopify-owned install surface, the App Store listing, and this derives it
 * from a handle read off the Partner Dashboard listing page. There is
 * deliberately no second source, and this was re-checked against Shopify's
 * documentation during review 132211:
 *
 *   • There is no store-picker install URL. Shopify's authorization-code-grant
 *     documentation gives exactly one authorize URL and it is per-shop
 *     (`https://{shop}/admin/oauth/authorize?...`), and states that an install
 *     link which does not originate from the App Store must supply `shop`
 *     itself. So there is nothing to fall back TO that would not mean asking
 *     the merchant to name their store - the thing requirement 2.3.1 forbids.
 *   • The listing handle is not exposed by the Partner API either. The `App`
 *     type carries only `apiKey`, `events`, `id` and `name`, so it cannot be
 *     discovered at runtime and must be configured.
 *   • A custom-distribution install link is generated per STORE, so
 *     configuring one would hard-code a single merchant's shop into the button
 *     every other merchant presses.
 *
 * SCOPE OF THIS FUNCTION - important. It powers ONE thing: the button. It is
 * NOT part of the install path. A merchant arriving from Shopify (the App
 * Store listing, or Partner Dashboard "Test your app") reaches
 * `application_url` directly, and the public install handler verifies that
 * request and starts OAuth without ever calling this. So a null here means
 * "no in-app shortcut", never "installation is broken" - see the tests in
 * shopify-install-route.test.ts that pin exactly that.
 *
 * Returns null when unset or malformed. Null is an ORDINARY state and callers
 * must render it as one: it may not become a blocked button or an error.
 */
export function resolveShopifyInstallUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const handle = resolveShopifyAppStoreHandle(env);
  if (!handle) return null;
  return `https://apps.shopify.com/${handle}`;
}

/**
 * Whether the App Store listing is actually reachable by a merchant.
 *
 * This exists because "the slug is configured" and "the page loads" are
 * different facts, and conflating them put a 404 behind the Connect button.
 *
 * An App Store listing is only publicly reachable once the app is APPROVED.
 * Before that it renders for Partner-account viewers and returns what looks
 * like a 404 to everyone else - and an app set to "Limited visibility" never
 * appears in App Store search at all, even after approval. So there is no URL
 * to send a merchant to before publication, and no search page that would find
 * us either.
 *
 * Off by default, because being wrong in that direction shows an honest
 * explanation, and being wrong in the other direction shows a 404.
 */
function listingIsLive(env: NodeJS.ProcessEnv): boolean {
  return String(env.SHOPIFY_APP_STORE_LISTING_LIVE || "").toLowerCase().trim() === "true";
}

/**
 * Where "Connect Shopify" goes, or why it cannot go anywhere yet.
 *
 * A discriminated result rather than a nullable URL: the two states need
 * different UI, and a `null` that callers were free to interpret is how the
 * 503 and then the 404 both happened.
 */
export type ShopifyInstallEntry =
  /** The listing is live and configured. Navigate here. */
  | { mode: "listing"; url: string }
  /**
   * No reachable Shopify page exists yet. The UI must EXPLAIN that
   * installation begins on Shopify. It must not navigate, must not present
   * this as an error, and must never ask for a shop domain.
   */
  | { mode: "not_published"; url: null };

/**
 * Where "Connect Shopify" sends a merchant, or why it cannot send them yet.
 *
 * THE HISTORY, BECAUSE IT HAS BEEN WRONG TWICE
 * --------------------------------------------
 * First this route answered `503 shopify_install_not_available` whenever the
 * listing slug was unset, and Shopify App Store review 132211 quoted the
 * resulting screen back under requirement 4.5.5.
 *
 * The fix for that was worse in a quieter way: it always produced a URL,
 * falling back to App Store search. But an unapproved listing 404s for anyone
 * not signed in to a Partner account, and this app is "Limited visibility", so
 * it will never appear in App Store search even after approval. The button
 * stopped refusing and started leading to a dead page instead.
 *
 * So the state is now explicit. Before publication there is no reachable
 * Shopify page, and the honest answer is to say installation begins on
 * Shopify - which is exactly what Shopify Support advised: before publication
 * the in-app button is not the reviewer's entry point, and no special
 * pre-publication URL is needed.
 *
 * Neither branch asks the merchant to type a `.myshopify.com` domain, which is
 * what requirement 2.3.1 actually forbids.
 *
 * Going live is one environment variable: set SHOPIFY_APP_STORE_LISTING_LIVE
 * once the listing is approved. No code change, no deploy.
 */
export function resolveShopifyInstallEntry(
  env: NodeJS.ProcessEnv = process.env,
): ShopifyInstallEntry {
  const listing = resolveShopifyInstallUrl(env);
  if (listing && listingIsLive(env)) return { mode: "listing", url: listing };
  return { mode: "not_published", url: null };
}
