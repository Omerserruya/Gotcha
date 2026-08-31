/**
 * The manual GraphQL Billing API - appSubscriptionCreate and friends.
 *
 * Kept as a complete second implementation rather than a fallback, because two
 * facts may force us onto it and neither is settled:
 *
 *   * App Pricing's support for NON-EMBEDDED apps is undocumented, and GOTCHA's
 *     Shopify app is `embedded = false`.
 *   * App Pricing verification needs an organisation-level Partner API
 *     credential; this path needs only the shop's own Admin token.
 *
 * Why it delegates instead of calling Shopify directly
 * ----------------------------------------------------
 * This path needs the MERCHANT'S Admin access token. That token belongs to
 * services/ai, which owns the Shopify integration, and CLAUDE.md is explicit:
 * a service owns its domain and others reach it through its API, never through
 * its tables. Reading `ShopifyChatInstallation.accessToken` from the billing
 * service would cross that boundary, and it would also mean a second place in
 * the codebase that decrypts merchant credentials.
 *
 * So the shape is: billing decides WHAT should happen (money state is its
 * domain), and services/ai performs the Shopify call (the credential is its
 * domain). Billing never sees the token.
 *
 * App Pricing needs no such hop because its credential is app-level, which is
 * the quiet reason it fits this codebase better.
 */
import type { BillingSource } from "@prisma/client";
import { SHOPIFY_MANUAL_CAPABILITIES } from "../capabilities";
import {
  BillingSourceUnavailableError,
  type BeginSubscriptionInput,
  type BeginSubscriptionResult,
  type BillingSourceProvider,
  type ObservedSubscription,
  type ProviderSubscriptionRef,
} from "../source";
import { isShopifyBillingMock } from "./config";
import { mapShopifyStatus } from "./status-map";

const SOURCE: BillingSource = "SHOPIFY";

function aiServiceUrl(): string {
  return process.env.AI_SERVICE_URL || "http://ai:4006";
}

/**
 * Call the internal Shopify-billing endpoint on services/ai.
 *
 * Same convention as `lib/auth-notify.ts`: service DNS plus the shared
 * X-Internal-Key. The key is read at call time so a rotation does not need a
 * restart of this module.
 */
async function callAi<T>(path: string, body: unknown): Promise<T> {
  const key = process.env.INTERNAL_SERVICE_KEY || process.env.INTERNAL_SERVICE_TOKEN;
  if (!key) {
    throw new BillingSourceUnavailableError(
      SOURCE,
      "INTERNAL_SERVICE_KEY is not set, so billing cannot ask services/ai to perform a Shopify call",
    );
  }
  const res = await fetch(`${aiServiceUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // No body echoed: an internal error response is not a place to assume a
    // token or a merchant identifier was not included.
    throw new BillingSourceUnavailableError(
      SOURCE,
      `services/ai answered HTTP ${res.status} for ${path}`,
    );
  }
  return (await res.json()) as T;
}

export const shopifyManualBillingSource: BillingSourceProvider = {
  source: SOURCE,
  capabilities: SHOPIFY_MANUAL_CAPABILITIES,

  /**
   * Ask services/ai to run `appSubscriptionCreate` and hand back Shopify's
   * `confirmationUrl`.
   *
   * The status is PENDING regardless of what comes back. `confirmationUrl` is
   * where the merchant goes to APPROVE; it is not evidence that they did. Only
   * `fetchSubscription` may move this to ACTIVE.
   */
  async beginSubscription(input: BeginSubscriptionInput): Promise<BeginSubscriptionResult> {
    if (!input.externalShopId && !input.shopDomain) {
      throw new BillingSourceUnavailableError(SOURCE, "no shop to create a subscription for");
    }
    if (isShopifyBillingMock()) {
      return {
        redirectUrl: `https://example.test/mock-confirm/${encodeURIComponent(input.idempotencyKey)}`,
        externalId: `mock_sub_${input.idempotencyKey}`,
        status: "PENDING",
      };
    }

    const res = await callAi<{ confirmationUrl?: string; subscriptionId?: string }>(
      "/api/internal/shopify/billing/subscription-create",
      {
        shopId: input.externalShopId,
        shopDomain: input.shopDomain,
        planHandle: input.providerPlanHandle,
        planKey: input.planKey,
        returnUrl: input.returnUrl,
        trialDays: input.trialDays ?? undefined,
        idempotencyKey: input.idempotencyKey,
        // Shopify's own no-charge switch. Anything that is not a live
        // deployment must set it, so a development store is never billed.
        test: !isShopifyBillingMock() && process.env.SHOPIFY_BILLING_ENV !== "live",
      },
    );

    if (!res.confirmationUrl) {
      throw new BillingSourceUnavailableError(
        SOURCE,
        "appSubscriptionCreate returned no confirmationUrl - there is nowhere to send the merchant",
      );
    }
    return { redirectUrl: res.confirmationUrl, externalId: res.subscriptionId ?? null, status: "PENDING" };
  },

  /**
   * Read `currentAppInstallation { activeSubscriptions }` through services/ai.
   *
   * Null means Shopify reports no active subscription, which is a fact to act
   * on. A transport failure throws instead, because "we could not ask" must
   * never be mistaken for "they are not paying".
   */
  async fetchSubscription(ref: ProviderSubscriptionRef): Promise<ObservedSubscription | null> {
    if (!ref.externalShopId) {
      throw new BillingSourceUnavailableError(SOURCE, "cannot verify a subscription without a shop id");
    }
    if (isShopifyBillingMock()) return null;

    const res = await callAi<{ subscription: null | Record<string, any> }>(
      "/api/internal/shopify/billing/active-subscription",
      { shopId: ref.externalShopId, externalId: ref.externalId },
    );
    const sub = res.subscription;
    if (!sub) return null;

    return {
      externalId: sub.id ?? null,
      status: mapShopifyStatus(sub.status),
      rawStatus: sub.status ?? null,
      planHandle: sub.name ?? null,
      trialEndsAt: sub.trialDays && sub.createdAt
        ? new Date(new Date(sub.createdAt).getTime() + Number(sub.trialDays) * 86_400_000)
        : null,
      currentPeriodStart: sub.currentPeriodStart ? new Date(sub.currentPeriodStart) : null,
      currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null,
      cancelAtPeriodEnd: false,
      metadata: {},
    };
  },

  async cancelSubscription(ref: ProviderSubscriptionRef): Promise<void> {
    if (isShopifyBillingMock()) return;
    if (!ref.externalId) {
      throw new BillingSourceUnavailableError(SOURCE, "cannot cancel a subscription with no provider id");
    }
    await callAi("/api/internal/shopify/billing/subscription-cancel", { subscriptionId: ref.externalId });
  },
};
