/**
 * The one place the Meta Graph API version is decided.
 *
 * Why this module exists
 * ----------------------
 * The version was declared independently in eight files across four services,
 * on three different versions at once:
 *
 *   v19.0  whatsapp.adapter, messenger.adapter, incoming.worker (x2),
 *          incoming-worker/whatsapp.service        ← EXPIRED 2026-05-21
 *   v21.0  instagram.adapter, auth/channels, conversation/templates,
 *          channel-health.worker
 *   v25.0  auth/channels:289 (inline, inside a multi-version fallback)
 *
 * Meta supports a version for a minimum of two years and then, like Shopify,
 * does not reject calls to an expired one - quoting the changelog: "any calls
 * made to it will be defaulted to the next oldest, usable version". So
 * WhatsApp and Messenger - the platform's primary channels - were being served
 * a contract nobody chose, and nothing reported it.
 *
 * Choosing the version
 * --------------------
 * Official table (developers.facebook.com/docs/graph-api/changelog, checked
 * 2026-07-31):
 *
 *   v26.0  released 2026-07-29   (two days old at time of writing)
 *   v25.0  released 2026-02-18   available until 2028-07-29
 *   v24.0  released 2025-10-08   available until 2028-02-18   ← chosen
 *   v23.0  released 2025-05-29   available until 2027-10-08
 *   v21.0  released 2024-10-02   available until 2027-01-21
 *   v19.0  released 2024-01-23   EXPIRED 2026-05-21
 *
 * v24.0: nine months of production maturity behind it and ~19 months of
 * runway ahead - comfortably more than one review cycle. v26.0 is too new to
 * put the primary customer channel on; v21.0 expires within six months.
 *
 * Compatible across WhatsApp Cloud API, Messenger, Instagram Graph, embedded
 * signup and the channel-connect routes, which is why one version can serve
 * all of them.
 */

/** Reviewed 2026-07-31. */
const DEFAULT_META_GRAPH_VERSION = "v24.0";

/** v24.0 is available until 2028-02-18; review with overlap still available. */
export const META_GRAPH_VERSION_REVIEW_BY = "2027-10-01";

const GRAPH_HOST = "https://graph.facebook.com";

/** `vNN.N` - the only shape Meta accepts. */
const VERSION_SHAPE = /^v\d{1,3}\.\d{1,2}$/;

/** Released and supported when this was written. Warning only, never a reject. */
const KNOWN_SUPPORTED = new Set(["v21.0", "v22.0", "v23.0", "v24.0", "v25.0", "v26.0"]);

/** Expired versions we specifically must never silently fall back to. */
const KNOWN_EXPIRED = new Set(["v19.0", "v20.0"]);

let cached: string | null = null;

/**
 * The canonical version. Override with `META_GRAPH_VERSION` - ONE validated
 * value, rather than the four full-URL variables this replaces.
 *
 * Throws on a malformed override. Falling back to the default silently is how
 * an operator ends up believing a version bump took effect when it did not.
 */
export function metaGraphVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (cached) return cached;
  const raw = (env.META_GRAPH_VERSION || "").trim();
  const chosen = raw || DEFAULT_META_GRAPH_VERSION;
  if (!VERSION_SHAPE.test(chosen)) {
    throw new Error(
      `[meta-graph] META_GRAPH_VERSION="${chosen}" is not a valid Graph API version. ` +
        `Expected vNN.N (for example "${DEFAULT_META_GRAPH_VERSION}").`,
    );
  }
  cached = chosen;
  return chosen;
}

/** Test seam - the cache would otherwise pin the first value read. */
export function __resetMetaGraphVersionCache(): void {
  cached = null;
}

/**
 * Base URL for graph.facebook.com - WhatsApp, Messenger, page/oauth calls.
 *
 * `legacyUrlEnv` keeps the pre-existing full-URL variables working
 * (`WHATSAPP_API_URL`, `FACEBOOK_API_URL`, `INSTAGRAM_API_URL`). They are
 * DEPRECATED but still honoured, because they are set in real deployments and
 * in docker-compose defaults - a hard cutover would silently change which
 * version a running system talks to, which is the exact failure this module
 * exists to prevent. A legacy override logs once so it can be retired.
 */
export function metaGraphBaseUrl(
  legacyUrlEnv?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const legacy = (legacyUrlEnv || "").trim();
  if (legacy) {
    warnLegacyOverride(legacy);
    return legacy.replace(/\/+$/, "");
  }
  return `${GRAPH_HOST}/${metaGraphVersion(env)}`;
}

/**
 * NOTE: there is deliberately NO helper for graph.instagram.com.
 *
 * The Instagram-Login flavour (`INSTAGRAM_API_URL`, default
 * `https://graph.instagram.com`) is **unversioned by design** - that host
 * rejects version-prefixed paths. Adding a version there would break every
 * Instagram-Login account, so it stays outside this module. See the comment
 * at `packages/shared/src/channels/instagram.adapter.ts`.
 *
 * Facebook-Login Instagram accounts use a Page token against
 * graph.facebook.com and DO go through `metaGraphBaseUrl()`.
 */

const warnedLegacy = new Set<string>();
function warnLegacyOverride(url: string): void {
  if (warnedLegacy.has(url)) return;
  warnedLegacy.add(url);
  const m = url.match(/\/(v\d{1,3}\.\d{1,2})(?:\/|$)/);
  const v = m?.[1];
  const expired = v && KNOWN_EXPIRED.has(v);
  console.warn(
    `[meta-graph] DEPRECATED full-URL override in use (${url}). ` +
      `Set META_GRAPH_VERSION instead - one validated value for every Meta surface.` +
      (expired
        ? ` THIS OVERRIDE PINS ${v}, WHICH META HAS EXPIRED: calls are being served by ` +
          `the next-oldest usable version, not ${v}.`
        : ""),
  );
}

/** Startup report. Logs; never throws for a well-formed unknown version. */
export function reportMetaGraphVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = metaGraphVersion(env);
  if (KNOWN_EXPIRED.has(v)) {
    console.error(
      `[meta-graph] configured version ${v} is EXPIRED. Meta will serve the next-oldest ` +
        `usable version instead, so the contract in use is NOT ${v}.`,
    );
  } else if (!KNOWN_SUPPORTED.has(v)) {
    console.warn(
      `[meta-graph] configured version ${v} is not in this build's known set ` +
        `(${[...KNOWN_SUPPORTED].join(", ")}). Expected after a Meta release - confirm at ` +
        `https://developers.facebook.com/docs/graph-api/changelog.`,
    );
  }
  console.log(`[meta-graph] Graph API version=${v} (review by ${META_GRAPH_VERSION_REVIEW_BY})`);
  return v;
}
