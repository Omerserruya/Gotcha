/**
 * The one place the Stripe API version is decided.
 *
 * Why this module exists
 * ----------------------
 * No `Stripe-Version` header was sent anywhere. Stripe's documented behaviour
 * when the header is absent is to use **the account's default API version** —
 * a setting in the Stripe Dashboard.
 *
 * So the effective API contract lived in a web console, not in this repository:
 * invisible to code review, unversioned, untested, and changeable by anyone
 * with dashboard access clicking "upgrade" — with no deploy and no diff.
 *
 * Stripe's own guidance, quoted from docs.stripe.com/upgrades:
 *
 *   "When performing an API upgrade, make sure that you specify the API
 *    version that you're integrating against in your code instead of relying
 *    on your account's default API version."
 *
 * How Stripe differs from Shopify and Meta
 * ---------------------------------------
 * Shopify and Meta EXPIRE versions and silently fall forward, so the risk
 * there is an aging pin. Stripe does not expire versions — a pinned version
 * keeps working indefinitely, which is the whole point of pinning. The risk
 * here is the opposite: having no pin at all, and inheriting whatever the
 * dashboard says today.
 *
 * That difference is why this is a separate module rather than a shared
 * abstraction over all three: the failure modes, and therefore the correct
 * behaviours, are genuinely different.
 *
 * Choosing the version
 * --------------------
 * Stripe names major releases and ships backward-compatible monthly releases
 * within them. From docs.stripe.com/changelog (checked 2026-07-31):
 *
 *   Dahlia   2026-07-29   ← newest MAJOR, two days old
 *   Clover   2026-02-25   ← chosen
 *   Basil    2025-08-27
 *
 * Clover: a major release with five months of production behind it. Dahlia is
 * a brand-new MAJOR, and majors are where Stripe puts breaking changes —
 * adopting one sight-unseen, on the path that issues refunds against a
 * merchant's own Stripe account, is not a reasonable default. Moving to Dahlia
 * is a deliberate upgrade with its own migration review, not something to
 * inherit by accident.
 *
 * NOTE: Stripe here is a TOOL INTEGRATION (Stripe Connect, acting on the
 * merchant's account for refunds and payment links). It is NOT GOTCHA's own
 * billing provider — that is iCount (`BillingProvider` has one value). Nothing
 * in this module affects GOTCHA's subscriptions, invoices or dunning.
 */

/** Reviewed 2026-07-31. */
const DEFAULT_STRIPE_API_VERSION = "2026-02-25.clover";

/**
 * Stripe versions do not expire, so this is a "consider upgrading" date rather
 * than a deadline. By then Dahlia will have a year of production behind it.
 */
export const STRIPE_API_VERSION_REVIEW_BY = "2027-07-01";

/** `YYYY-MM-DD` or `YYYY-MM-DD.release-name`. */
const VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/;

let cached: string | null = null;

/**
 * The version every Stripe call must declare.
 *
 * Overridable with `STRIPE_API_VERSION`. Throws on a malformed value rather
 * than falling back: a silent fallback would put the account default back in
 * charge, which is the exact condition this module exists to remove.
 */
export function stripeApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (cached) return cached;
  const raw = (env.STRIPE_API_VERSION || "").trim();
  const chosen = raw || DEFAULT_STRIPE_API_VERSION;
  if (!VERSION_SHAPE.test(chosen)) {
    throw new Error(
      `[stripe-version] STRIPE_API_VERSION="${chosen}" is not a valid Stripe API version. ` +
        `Expected YYYY-MM-DD or YYYY-MM-DD.release (for example "${DEFAULT_STRIPE_API_VERSION}").`,
    );
  }
  cached = chosen;
  return chosen;
}

/** Test seam — the cache would otherwise pin the first value read. */
export function __resetStripeApiVersionCache(): void {
  cached = null;
}

/**
 * Headers every Stripe request must carry. Centralised so a new call site
 * cannot forget the version and quietly inherit the dashboard default —
 * which is how this integration spent its whole life until now.
 */
export function stripeVersionHeader(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { "Stripe-Version": stripeApiVersion(env) };
}

/** Startup report, so the pinned version is visible without reading adapter source. */
export function reportStripeApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = stripeApiVersion(env);
  console.log(
    `[stripe-version] API version=${v} (pinned in code, not the account default; ` +
      `review by ${STRIPE_API_VERSION_REVIEW_BY})`,
  );
  return v;
}
