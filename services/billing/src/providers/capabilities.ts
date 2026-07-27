/**
 * Provider capabilities, as a typed contract rather than scattered guesswork.
 *
 * Every capability is one of three states, and only `verified` permits use:
 *
 *   verified     confirmed against official documentation, the real account, or
 *                a written answer from the provider
 *   unverified   plausible but not confirmed - treated exactly like unsupported
 *   unsupported  the provider does not offer it
 *
 * `unverified` failing closed is the whole point. The previous implementation
 * shipped invented endpoints that looked reasonable and would have failed at a
 * customer's renewal; a capability that is merely probable buys nothing.
 */
export type CapabilityState = "verified" | "unverified" | "unsupported";

export interface ProviderCapabilities {
  /** The hosted page can store a reusable card token. */
  tokenization: CapabilityState;
  /**
   * How the stored token is handed back after tokenization - IPN, redirect, or
   * fetched from the customer record. Checkout cannot be enabled without this,
   * because otherwise "the browser came back" is the only success signal, and a
   * browser redirect is not proof of anything.
   */
  tokenRetrievalContract: CapabilityState;
  /** The stored token can be charged unattended (merchant-initiated). */
  storedCardCharge: CapabilityState;
  /** The provider deduplicates on a merchant-supplied reference. */
  providerIdempotency: CapabilityState;
  fullRefund: CapabilityState;
  partialRefund: CapabilityState;
  /**
   * Currencies a charge may actually be submitted in. Anything absent here is
   * refused rather than sent and hoped for.
   */
  chargeCurrencies: readonly string[];
}

/**
 * iCount, as of the last verification round.
 *
 * Sources: written confirmation from iCount support (cc/bill, cc/transactions,
 * doc/cancel) and authenticated read-only discovery of the account and PayPage
 * (doctype = cc_token, hk_page = 0).
 */
export const ICOUNT_CAPABILITIES: ProviderCapabilities = {
  // The PayPage is confirmed to be type cc_token, so the page can tokenize.
  tokenization: "verified",

  // ...but how it returns the token is NOT confirmed. This single field is what
  // keeps the customer-facing checkout disabled.
  tokenRetrievalContract: "unverified",

  // Written confirmation: POST cc/bill, without customer presence, without CVV,
  // for merchant-initiated transactions and monthly renewal.
  storedCardCharge: "verified",

  // No provider-side idempotency mechanism has been confirmed. GOTCHA's own
  // database uniqueness is therefore the only double-charge guard, and
  // reconciliation via cc/transactions is the recovery path.
  providerIdempotency: "unsupported",

  // Written confirmation: POST doc/cancel with refund_cc: true, full only.
  fullRefund: "verified",
  partialRefund: "unsupported",

  // cc/bill has no confirmed currency parameter. ILS is the account's base
  // currency and therefore what an omitted-currency charge settles in; every
  // other currency is refused, so a USD plan price can never be quietly
  // charged as ILS.
  chargeCurrencies: ["ILS"],
} as const;

/** Manual/offline provider: no automated money movement at all. */
export const MANUAL_CAPABILITIES: ProviderCapabilities = {
  tokenization: "unsupported",
  tokenRetrievalContract: "unsupported",
  storedCardCharge: "unsupported",
  providerIdempotency: "unsupported",
  fullRefund: "unsupported",
  partialRefund: "unsupported",
  chargeCurrencies: [],
} as const;

export class CapabilityUnavailableError extends Error {
  constructor(readonly capability: string, readonly state: CapabilityState) {
    super(`[billing] capability "${capability}" is ${state} - refusing to proceed`);
    this.name = "CapabilityUnavailableError";
  }
}

/** Throw unless the capability is verified. `unverified` is not good enough. */
export function assertCapability(
  caps: ProviderCapabilities,
  capability: keyof Omit<ProviderCapabilities, "chargeCurrencies">,
): void {
  const state = caps[capability];
  if (state !== "verified") throw new CapabilityUnavailableError(String(capability), state);
}

/** Throw unless this exact currency is verified as chargeable. */
export function assertChargeCurrency(caps: ProviderCapabilities, currency: string): void {
  const wanted = (currency || "").toUpperCase();
  if (!caps.chargeCurrencies.includes(wanted)) {
    throw new Error(
      `[billing] refusing a ${wanted || "(unspecified)"} charge: the provider's currency contract is unverified for it (verified: ${caps.chargeCurrencies.join(", ") || "none"})`,
    );
  }
}

/**
 * Whether the customer-facing checkout may be switched on.
 *
 * Requires BOTH the ability to store a card and a known way to learn, on the
 * server, that it was stored. Missing the second is exactly the state that
 * would force the frontend to trust a redirect.
 */
export function checkoutEnabled(caps: ProviderCapabilities): boolean {
  return caps.tokenization === "verified" && caps.tokenRetrievalContract === "verified";
}
