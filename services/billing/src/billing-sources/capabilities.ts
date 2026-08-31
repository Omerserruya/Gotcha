/**
 * What a billing source is VERIFIED to be able to do.
 *
 * Same three-state contract as `providers/capabilities.ts`, and for the same
 * reason: `unverified` is treated exactly like `unsupported`, so a capability
 * that is merely plausible fails closed at the call site rather than failing at
 * a merchant's renewal.
 *
 * It earns its keep twice over here. The iCount round proved the general point
 * - invented endpoints look reasonable right up until they take someone's
 * money. The Shopify round adds a second, sharper one: we do not yet know
 * whether Shopify permits split billing, and `splitBilling: "unverified"` is
 * how that unanswered question is expressed in code instead of in a comment
 * that nothing enforces.
 */
import type { BillingSource } from "@prisma/client";

export type CapabilityState = "verified" | "unverified" | "unsupported";

export interface BillingSourceCapabilities {
  /** The source can start a subscription the merchant approves. */
  createSubscription: CapabilityState;
  /**
   * The source can be ASKED, authoritatively, what a subscription's state is.
   *
   * Nothing may be activated without this. It is the direct analogue of
   * `tokenRetrievalContract` in the payment-provider capabilities: without a
   * server-side read, a browser redirect is the only success signal, and a
   * browser redirect is not evidence.
   */
  verifySubscription: CapabilityState;
  cancelSubscription: CapabilityState;
  /** Metered usage can be reported to this source. */
  usageReporting: CapabilityState;
  /** A reported unit can be corrected or reversed. */
  usageReversal: CapabilityState;
  /** The source tells us about changes without being asked. */
  subscriptionWebhooks: CapabilityState;
  /**
   * This source may fund SOME of a workspace's entitlements while another
   * source funds the rest.
   *
   * `unverified` for Shopify, deliberately and until they answer. It is not a
   * technical limit - the schema models it fine - it is a POLICY question, and
   * guessing wrong means either an App Store rejection or a merchant billed
   * twice for one capability.
   */
  splitBilling: CapabilityState;
}

/**
 * GOTCHA's own billing. Verified because it is what production does today, and
 * every one of these has been exercised by the existing suite.
 *
 * `subscriptionWebhooks` is unsupported rather than verified: the iCount
 * callback contract is still unverified (see ProviderBillingEvent's comment),
 * and the scheduler plus reconciliation are what actually keep state correct.
 */
export const GOTCHA_EXTERNAL_CAPABILITIES: BillingSourceCapabilities = {
  createSubscription: "verified",
  verifySubscription: "verified",
  cancelSubscription: "verified",
  usageReporting: "verified",
  usageReversal: "verified",
  subscriptionWebhooks: "unsupported",
  splitBilling: "verified",
} as const;

/**
 * Shopify App Pricing (formerly "Managed Pricing"), as documented on
 * shopify.dev and checked on 2026-08-31.
 *
 * `subscriptionWebhooks: "unsupported"` is not a gap in our implementation. It
 * is Shopify's own current behaviour: since 2026-04-28 App Pricing sends no
 * webhooks for subscription changes and no longer appends `charge_id` to the
 * redirect. Reconciliation against the Partner API is therefore the ONLY way
 * this source's state can be known, which is why `verifySubscription` has to
 * be verified before this source may be enabled at all.
 *
 * Everything here stays `unverified` until it has been exercised against a real
 * development store. Shipping it as `verified` on the strength of documentation
 * is exactly the mistake the capability table exists to prevent.
 */
export const SHOPIFY_APP_PRICING_CAPABILITIES: BillingSourceCapabilities = {
  createSubscription: "unverified",
  verifySubscription: "unverified",
  // App Pricing plan changes are the merchant's to make in the Shopify admin;
  // there is no documented app-initiated cancel.
  cancelSubscription: "unsupported",
  usageReporting: "unverified",
  usageReversal: "unverified",
  subscriptionWebhooks: "unsupported",
  splitBilling: "unverified",
} as const;

/**
 * The manual GraphQL Billing API - appSubscriptionCreate and friends.
 *
 * Kept as a separate, complete implementation rather than a fallback, because
 * two facts may force us onto it: App Pricing's support for NON-EMBEDDED apps
 * is undocumented (and GOTCHA's Shopify app is `embedded = false`), and App
 * Pricing verification needs an organisation-level Partner API credential,
 * where this path needs only the shop's own Admin token.
 */
export const SHOPIFY_MANUAL_CAPABILITIES: BillingSourceCapabilities = {
  createSubscription: "unverified",
  verifySubscription: "unverified",
  cancelSubscription: "unverified",
  usageReporting: "unverified",
  usageReversal: "unsupported",
  subscriptionWebhooks: "unverified",
  splitBilling: "unverified",
} as const;

/** Never charged, by decision. Nothing to verify and nothing to call. */
export const NON_CHARGING_CAPABILITIES: BillingSourceCapabilities = {
  createSubscription: "unsupported",
  verifySubscription: "unsupported",
  cancelSubscription: "unsupported",
  usageReporting: "unsupported",
  usageReversal: "unsupported",
  subscriptionWebhooks: "unsupported",
  splitBilling: "verified",
} as const;

export class BillingCapabilityUnavailableError extends Error {
  readonly code = "BILLING_CAPABILITY_UNAVAILABLE";
  constructor(
    readonly billingSource: BillingSource,
    readonly capability: string,
    readonly state: CapabilityState,
  ) {
    super(
      `[billing-source] ${billingSource} capability "${capability}" is ${state} - refusing to proceed`,
    );
    this.name = "BillingCapabilityUnavailableError";
  }
}

/** Throw unless the capability is verified. `unverified` is not good enough. */
export function assertBillingCapability(
  billingSource: BillingSource,
  caps: BillingSourceCapabilities,
  capability: keyof BillingSourceCapabilities,
): void {
  const state = caps[capability];
  if (state !== "verified") {
    throw new BillingCapabilityUnavailableError(billingSource, String(capability), state);
  }
}

/** Non-throwing form, for deciding what a UI may offer. */
export function hasBillingCapability(
  caps: BillingSourceCapabilities,
  capability: keyof BillingSourceCapabilities,
): boolean {
  return caps[capability] === "verified";
}
