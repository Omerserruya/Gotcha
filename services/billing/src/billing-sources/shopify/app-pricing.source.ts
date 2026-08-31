/**
 * Shopify App Pricing (formerly "Managed Pricing").
 *
 * Shopify hosts plan selection, owns renewal and collection, and applies
 * trials, proration and price changes itself. GOTCHA's job reduces to three
 * things: send the merchant to the right page, find out what they actually
 * chose, and report usage.
 *
 * The fact that shapes this entire file
 * -------------------------------------
 * **App Pricing sends no subscription webhooks.** Since 2026-04-28 Shopify has
 * sent no `APP_SUBSCRIPTIONS_UPDATE` and no longer appends `charge_id` to the
 * redirect; the merchant comes back with only `plan_handle` and `shop`.
 *
 * So `fetchSubscription` is not a safety net that catches missed events - it is
 * the ONLY way this integration can ever learn anything. Two consequences run
 * through the code:
 *
 *   1. The return URL is never evidence. `beginSubscription` reports PENDING no
 *      matter what, and only a Partner API read can move a subscription to
 *      ACTIVE.
 *   2. Reconciliation is mandatory rather than optional, and its cadence is the
 *      real bound on how quickly we notice a cancellation.
 *
 * Why this fits GOTCHA's service boundaries better than it first appears
 * ---------------------------------------------------------------------
 * Verification uses the **Partner API**, whose credential is
 * organisation-level. That means the billing service can hold it directly and
 * never touches a merchant's Admin access token - which belongs to
 * services/ai. The manual Billing API needs the shop's own token and therefore
 * cannot be implemented here without crossing that boundary; see
 * manual-billing.source.ts for how that one is arranged instead.
 */
import type { BillingSource } from "@prisma/client";
import { SHOPIFY_APP_PRICING_CAPABILITIES } from "../capabilities";
import {
  BillingSourceUnavailableError,
  type BeginSubscriptionInput,
  type BeginSubscriptionResult,
  type BillingSourceProvider,
  type ObservedSubscription,
  type ProviderSubscriptionRef,
  type UsageDispatchInput,
  type UsageDispatchResult,
  type UsageReversalInput,
} from "../source";
import {
  isShopifyBillingMock,
  shopifyPlanSelectionUrl,
  shopifyUsageBillingEnabled,
} from "./config";
import { mapShopifyStatus } from "./status-map";
import { sendBillingEvent } from "./app-events.client";
import { queryActiveSubscription } from "./partner-api.client";

const SOURCE: BillingSource = "SHOPIFY";

export const shopifyAppPricingSource: BillingSourceProvider = {
  source: SOURCE,
  capabilities: SHOPIFY_APP_PRICING_CAPABILITIES,

  /**
   * Hand back Shopify's hosted plan-selection URL.
   *
   * Nothing is created on Shopify's side here - under App Pricing there is no
   * `appSubscriptionCreate` to call, because the plans live in the Partner
   * Dashboard and the merchant picks one there. So this only builds a redirect,
   * and the status it reports is PENDING because that is the only honest thing
   * to say about a merchant who has not chosen yet.
   */
  async beginSubscription(input: BeginSubscriptionInput): Promise<BeginSubscriptionResult> {
    const handle = input.shopDomain || input.externalShopId;
    if (!handle) {
      throw new BillingSourceUnavailableError(SOURCE, "no shop domain to build a plan-selection URL from");
    }
    const url = shopifyPlanSelectionUrl(handle);
    if (!url) {
      throw new BillingSourceUnavailableError(
        SOURCE,
        "SHOPIFY_APP_HANDLE is not configured, so there is no plan-selection page to send the merchant to",
      );
    }
    return { redirectUrl: url, externalId: null, status: "PENDING" };
  },

  /**
   * Ask Shopify what is actually true.
   *
   * Returns null when Shopify has no active contract for this shop. That is a
   * real answer and it means "revoke" - not "leave whatever we last believed in
   * place". Getting this backwards is how a cancelled merchant keeps paid
   * access indefinitely.
   */
  async fetchSubscription(ref: ProviderSubscriptionRef): Promise<ObservedSubscription | null> {
    if (!ref.externalShopId) {
      throw new BillingSourceUnavailableError(SOURCE, "cannot verify a subscription without a shop id");
    }

    if (isShopifyBillingMock()) {
      // No network, and deliberately no invented subscription: a mock that
      // hands back an ACTIVE contract would let the activation path pass its
      // tests without ever proving it checks anything.
      return null;
    }

    const active = await queryActiveSubscription(ref.externalShopId);
    if (!active) return null;

    return {
      externalId: active.id ?? null,
      status: mapShopifyStatus(active.status),
      rawStatus: active.status ?? null,
      planHandle: active.planHandle ?? null,
      trialEndsAt: active.trialEndsAt ?? null,
      currentPeriodStart: active.currentPeriodStart ?? null,
      currentPeriodEnd: active.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: active.cancelAtEndOfCycle ?? false,
      // Redacted by the client before it gets here.
      metadata: active.metadata ?? {},
    };
  },

  async dispatchUsage(input: UsageDispatchInput): Promise<UsageDispatchResult> {
    if (!shopifyUsageBillingEnabled()) {
      return {
        accepted: false,
        permanent: true,
        failureCode: "shopify_usage_billing_disabled",
        failureReason: "SHOPIFY_USAGE_BILLING_ENABLED is not true",
      };
    }
    if (!input.externalShopId) {
      // Shopify bills a SHOP. Without one there is nobody to charge, and
      // guessing would attribute usage to the wrong merchant - which is worse
      // than not billing it.
      return {
        accepted: false,
        permanent: true,
        failureCode: "missing_shop_id",
        failureReason: "a billable event must name the shop it belongs to",
      };
    }
    return sendBillingEvent({
      shopId: input.externalShopId,
      eventHandle: input.meterHandle,
      quantity: input.quantity,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    });
  },

  /**
   * A correction is a negative event under a NEW key, which is exactly what
   * `dispatchUsage` already does - the ledger has written the negative quantity
   * and minted the new key before this is called.
   */
  async reverseUsage(input: UsageReversalInput): Promise<UsageDispatchResult> {
    return shopifyAppPricingSource.dispatchUsage!(input);
  },
};
