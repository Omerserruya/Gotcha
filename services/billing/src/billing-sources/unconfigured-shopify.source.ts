/**
 * What SHOPIFY resolves to when Shopify billing is switched off or unconfigured.
 *
 * This is the fail-closed state, and it is a real implementation of the
 * contract rather than a placeholder. Every method refuses, loudly, with a
 * reason a log reader can act on.
 *
 * Refusing is the only safe behaviour in both directions:
 *
 *   * It must not GRANT anything. Falling back to "allow" while unconfigured
 *     would hand out paid Shopify capabilities for free, and nothing would
 *     surface it because everything would appear to work.
 *   * It must not CHARGE anything. Falling back to a real adapter because a
 *     flag was missing is how a half-configured deployment takes money it was
 *     never authorised to take.
 *
 * `fetchSubscription` returns null rather than throwing. Null already means "no
 * subscription here", which is exactly true when the integration is off, and it
 * lets reconciliation and the entitlement path run normally on a stack where
 * Shopify billing is simply not in use - which is every stack today.
 */
import type { BillingSource } from "@prisma/client";
import { SHOPIFY_APP_PRICING_CAPABILITIES } from "./capabilities";
import {
  BillingSourceUnavailableError,
  type BeginSubscriptionInput,
  type BeginSubscriptionResult,
  type BillingSourceProvider,
  type ObservedSubscription,
  type ProviderSubscriptionRef,
  type UsageDispatchInput,
  type UsageDispatchResult,
} from "./source";

/** Every capability forced to unsupported - nothing here is available. */
const UNAVAILABLE = {
  ...SHOPIFY_APP_PRICING_CAPABILITIES,
  createSubscription: "unsupported",
  verifySubscription: "unsupported",
  usageReporting: "unsupported",
  usageReversal: "unsupported",
  splitBilling: "unsupported",
} as const;

export function makeUnconfiguredShopifySource(reason: string): BillingSourceProvider {
  const source: BillingSource = "SHOPIFY";
  return {
    source,
    capabilities: UNAVAILABLE,

    async beginSubscription(_i: BeginSubscriptionInput): Promise<BeginSubscriptionResult> {
      throw new BillingSourceUnavailableError(source, reason);
    },

    async fetchSubscription(_ref: ProviderSubscriptionRef): Promise<ObservedSubscription | null> {
      // See the header: null, not a throw. "Shopify billing is not in use here"
      // is a true and useful answer, and it keeps the reconciliation job and
      // the entitlement path working on every stack that has not enabled this.
      return null;
    },

    async dispatchUsage(_i: UsageDispatchInput): Promise<UsageDispatchResult> {
      // Permanent, so the dispatcher records SKIPPED and stops rather than
      // retrying forever against an integration that is switched off. The
      // ledger row itself is untouched and can be dispatched later if Shopify
      // billing is enabled - nothing is lost, only deferred.
      return {
        accepted: false,
        permanent: true,
        failureCode: "shopify_billing_unconfigured",
        failureReason: reason,
      };
    },
  };
}
