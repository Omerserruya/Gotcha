/**
 * The billing-source registry.
 *
 * Mirrors `providers/index.ts` - one lookup, no branching at call sites - with
 * one deliberate difference: SHOPIFY is resolved on EVERY call rather than
 * frozen into a module-level map.
 *
 * That is not an oversight. Which Shopify implementation is correct depends on
 * `SHOPIFY_BILLING_MODE`, and a frozen map would capture whatever the
 * environment happened to say when the module was first imported. In tests that
 * means the first file to import this decides the mode for every file after it,
 * which is precisely the class of order-dependent bug that makes a suite lie.
 * The lookup is a few string comparisons; correctness is worth more.
 */
import type { BillingSource } from "@prisma/client";
import { gotchaExternalSource } from "./gotcha-external.source";
import { exemptSource, freeSource } from "./non-charging.source";
import { makeUnconfiguredShopifySource } from "./unconfigured-shopify.source";
import { shopifyAppPricingSource } from "./shopify/app-pricing.source";
import { shopifyManualBillingSource } from "./shopify/manual-billing.source";
import { shopifyBillingEnabled, shopifyBillingMode } from "./shopify/config";
import type { BillingSourceProvider } from "./source";

export * from "./source";
export * from "./capabilities";

/**
 * Resolve the SHOPIFY source for the current configuration.
 *
 * Anything other than an explicitly recognised, enabled mode yields the
 * unconfigured source, which refuses everything. There is no fallback to a
 * "reasonable default" - a default way of charging people is not reasonable.
 */
function resolveShopifySource(): BillingSourceProvider {
  if (!shopifyBillingEnabled()) {
    return makeUnconfiguredShopifySource("SHOPIFY_BILLING_ENABLED is not true");
  }
  switch (shopifyBillingMode()) {
    case "app_pricing":
      return shopifyAppPricingSource;
    case "manual":
      return shopifyManualBillingSource;
    default:
      return makeUnconfiguredShopifySource(
        "SHOPIFY_BILLING_MODE is unset or unrecognised",
      );
  }
}

/**
 * The source responsible for collecting money for one subscription.
 *
 * Never throws for an unknown value: an unrecognised source resolves to EXEMPT,
 * which charges nothing and grants nothing new. Throwing here would take down a
 * request path over a data problem, and failing to a non-charging source is the
 * safer of the two wrong answers.
 */
export function getBillingSource(source: BillingSource): BillingSourceProvider {
  switch (source) {
    case "GOTCHA_EXTERNAL":
      return gotchaExternalSource;
    case "SHOPIFY":
      return resolveShopifySource();
    case "FREE":
      return freeSource;
    case "EXEMPT":
    default:
      return exemptSource;
  }
}

/**
 * Whether Shopify billing is usable right now.
 *
 * The question the UI and the policy resolver both ask before offering a
 * Shopify path. Separate from `shopifyBillingEnabled()` because a flag being on
 * is not the same as the adapter being able to verify a subscription, and it is
 * verification - not the flag - that decides whether anything may be activated.
 */
export function shopifyBillingUsable(): boolean {
  return getBillingSource("SHOPIFY").capabilities.verifySubscription === "verified";
}
