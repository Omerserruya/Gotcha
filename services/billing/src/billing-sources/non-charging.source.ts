/**
 * EXEMPT and FREE: the two sources that never charge anybody.
 *
 * They are separate enum values rather than one, because they answer different
 * questions and a report that merges them is wrong. FREE is a commercial
 * choice - somebody selected a free tier and could select a paid one. EXEMPT is
 * an administrative decision - staff, a partner, an internal workspace - and it
 * is not revenue that failed to materialise.
 *
 * The implementation is identical, which is fine: what differs is what the row
 * MEANS, and that lives in the enum, not in behaviour.
 *
 * `fetchSubscription` reports ACTIVE with no period and no external id. That is
 * deliberate - these workspaces genuinely do have access, and returning null
 * would read as "no subscription, revoke everything" to the entitlement path.
 */
import { NON_CHARGING_CAPABILITIES } from "./capabilities";
import type {
  BeginSubscriptionInput,
  BeginSubscriptionResult,
  BillingSourceProvider,
  ObservedSubscription,
  ProviderSubscriptionRef,
} from "./source";

function make(source: "EXEMPT" | "FREE"): BillingSourceProvider {
  return {
    source,
    capabilities: NON_CHARGING_CAPABILITIES,

    async beginSubscription(_input: BeginSubscriptionInput): Promise<BeginSubscriptionResult> {
      // Nothing to approve and nowhere to send anyone: access is already the
      // answer. ACTIVE rather than PENDING, because PENDING would leave the
      // caller waiting for a confirmation that is never coming.
      return { redirectUrl: null, externalId: null, status: "ACTIVE" };
    },

    async fetchSubscription(_ref: ProviderSubscriptionRef): Promise<ObservedSubscription | null> {
      return {
        externalId: null,
        status: "ACTIVE",
        rawStatus: source,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        metadata: {},
      };
    },
  };
}

export const exemptSource = make("EXEMPT");
export const freeSource = make("FREE");
