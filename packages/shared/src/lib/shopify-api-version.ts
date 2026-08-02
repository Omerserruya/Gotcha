/**
 * The one place the Shopify Admin API version is decided.
 *
 * Why this module exists
 * ----------------------
 * The adapter pinned `2024-04` in a local `const`. That version reached end of
 * support around April 2025, and Shopify does not reject an unsupported
 * version - it **falls forward**:
 *
 *   "If your app targets an inaccessible version, Shopify falls forward and
 *    responds using the oldest accessible stable version."
 *   - https://shopify.dev/docs/api/usage/versioning (checked 2026-07-31)
 *
 * So the integration kept working while the contract it was actually served
 * moved every three months, with no deploy, no code change and no signal. The
 * only way to notice is the `X-Shopify-API-Version` response header, which
 * nothing read.
 *
 * Two rules follow, and both are enforced here rather than in the adapter:
 *
 *   1. The version is declared ONCE. A second `const API_VERSION` anywhere is
 *      how the last drift happened.
 *   2. Every response is checked against what we asked for. Drift becomes a
 *      log line instead of a mystery.
 *
 * Choosing the version
 * --------------------
 * Shopify ships quarterly and supports each stable version for a minimum of 12
 * months. As of 2026-07-31 the released stable versions are 2025-10, 2026-01,
 * 2026-04 and 2026-07; 2026-10 and 2027-01 are announced but not yet released.
 *
 * `2026-07` is chosen: newest RELEASED stable, supported until 2027-07-16.
 * Pinning an unreleased version would be the same class of mistake in the
 * other direction.
 *
 * NOTE on REST: the REST Admin API is *legacy* as of 2024-10-01, and from
 * 2025-04-01 all NEW PUBLIC apps must use GraphQL. GOTCHA's Shopify apps
 * predate that, so REST remains available to them - verified against
 * https://shopify.dev/docs/api/admin-rest (checked 2026-07-31), which
 * documents `/admin/api/2026-07/products.json` as current. A REST→GraphQL
 * migration is a separate, larger piece of work and is NOT required to move
 * off an expired version.
 */

/** Reviewed 2026-07-31. Re-check before this date - see REVIEW_BY. */
const DEFAULT_SHOPIFY_API_VERSION = "2026-07";

/**
 * When this pin should be revisited. 2026-07 is accessible until 2027-07-16;
 * this date is deliberately earlier so the review happens while there is still
 * overlap with a newer version to move to.
 */
export const SHOPIFY_API_VERSION_REVIEW_BY = "2027-04-01";

/** `YYYY-MM`, the only shape Shopify accepts. */
const VERSION_SHAPE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Versions known to be released and supported at the time of writing. Used for
 * a startup WARNING only - never to reject. Shopify releases every quarter and
 * this list will age; refusing to boot on an unrecognised-but-valid version
 * would turn a routine upgrade into an outage.
 */
const KNOWN_SUPPORTED = new Set(["2025-10", "2026-01", "2026-04", "2026-07"]);

let cached: string | null = null;

/**
 * The version every Shopify Admin call must use.
 *
 * `SHOPIFY_API_VERSION` env overrides the default so an operator can move
 * forward without a deploy - but only to something shaped like a real version.
 * A malformed override throws: silently falling back to the default would
 * reproduce exactly the invisible-drift problem this module exists to end.
 */
export function shopifyApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (cached) return cached;
  const raw = (env.SHOPIFY_API_VERSION || "").trim();
  const chosen = raw || DEFAULT_SHOPIFY_API_VERSION;
  if (!VERSION_SHAPE.test(chosen)) {
    throw new Error(
      `[shopify-version] SHOPIFY_API_VERSION="${chosen}" is not a valid Shopify API version. ` +
        `Expected YYYY-MM (for example "${DEFAULT_SHOPIFY_API_VERSION}").`,
    );
  }
  cached = chosen;
  return chosen;
}

/** Test seam - the module-level cache would otherwise pin the first value read. */
export function __resetShopifyApiVersionCache(): void {
  cached = null;
}

/**
 * Startup check. Logs, never throws for an unknown-but-well-formed version:
 * see KNOWN_SUPPORTED. Call once per service that talks to Shopify.
 */
export function reportShopifyApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = shopifyApiVersion(env);
  if (!KNOWN_SUPPORTED.has(v)) {
    console.warn(
      `[shopify-version] configured version ${v} is not in this build's known-supported set ` +
        `(${[...KNOWN_SUPPORTED].join(", ")}). That is expected after a Shopify quarterly release - ` +
        `confirm it against https://shopify.dev/docs/api/usage/versioning.`,
    );
  }
  console.log(`[shopify-version] Admin API version=${v} (review by ${SHOPIFY_API_VERSION_REVIEW_BY})`);
  return v;
}

/**
 * Compare what Shopify actually served against what we asked for.
 *
 * Called on EVERY Admin response. A mismatch means our pin is inaccessible and
 * Shopify fell forward - the integration still "works", which is precisely why
 * it has to be logged loudly rather than returned to a caller who cannot act
 * on it.
 *
 * Deliberately does not throw. Failing a live customer request because a
 * header disagrees would trade a silent problem for a louder outage.
 */
export function checkShopifyResponseVersion(opts: {
  requested: string;
  headerValue: string | null | undefined;
  /** For log context: "REST" or "GraphQL". */
  surface?: string;
  /** Shop domain, useful for narrowing which store is affected. */
  shop?: string;
}): { ok: boolean; served: string | null; reason?: "missing_header" | "version_mismatch" } {
  const served = (opts.headerValue || "").trim() || null;
  const where = opts.surface ? ` surface=${opts.surface}` : "";
  const who = opts.shop ? ` shop=${opts.shop}` : "";

  if (!served) {
    console.warn(
      `[shopify-version] response carried no X-Shopify-API-Version header` +
        `${where}${who} requested=${opts.requested}. Cannot confirm which contract was served.`,
    );
    return { ok: false, served: null, reason: "missing_header" };
  }
  if (served !== opts.requested) {
    console.error(
      `[shopify-version] VERSION DRIFT: requested=${opts.requested} served=${served}` +
        `${where}${who}. Shopify fell forward because the requested version is no longer ` +
        `accessible. The API contract in use is NOT the one this build targets - ` +
        `update the pin in packages/shared/src/lib/shopify-api-version.ts.`,
    );
    return { ok: false, served, reason: "version_mismatch" };
  }
  return { ok: true, served };
}
