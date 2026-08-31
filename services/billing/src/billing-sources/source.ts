/**
 * Billing SOURCE - who collects the money - as distinct from payment PROVIDER,
 * which is who holds the card.
 *
 * Why this is a second port rather than another PaymentProvider
 * ------------------------------------------------------------
 * `providers/provider.ts` is a card-movement contract: tokenize a card, charge
 * it, refund it, verify the provider's webhook. Every method assumes GOTCHA is
 * the one moving money.
 *
 * Shopify moves the money itself. There is no token for us to store, no charge
 * for us to submit, and no refund for us to issue. Implementing PaymentProvider
 * for Shopify would mean five methods that throw and a capability set that is
 * almost entirely `unsupported` - at which point `assertCapability` would
 * correctly refuse to use it, and the adapter would be dead on arrival.
 *
 * So this port sits ABOVE PaymentProvider rather than beside it:
 *
 *     BillingSourceProvider          "who bills for this subscription"
 *       ├── GOTCHA_EXTERNAL  ──────> PaymentProvider registry (iCount today)
 *       ├── SHOPIFY          ──────> Shopify App Pricing | manual Billing API
 *       ├── EXEMPT / FREE    ──────> nothing is ever charged
 *
 * Entitlement logic sits above BOTH and knows about neither. That is the whole
 * point: `isEntitled()` must keep working unchanged whichever of these paid.
 *
 * The one rule every implementation obeys
 * ---------------------------------------
 * `fetchSubscription()` is the ONLY thing allowed to activate anything. Not a
 * return URL, not a redirect parameter, not a webhook body. A browser arriving
 * at a success URL proves the browser arrived; it is not proof that anybody
 * paid. This is the same reasoning that made `listStoredCards` the accepted
 * proof of tokenization in the iCount path, and it matters more here: Shopify
 * App Pricing sends NO subscription webhooks at all since 2026-04-28, so an
 * independent read is not a safety net, it is the only mechanism.
 */
import type { BillingSource, ProviderSubscriptionStatus } from "@prisma/client";
import type { BillingSourceCapabilities } from "./capabilities";

/** Identifies one provider-owned subscription well enough to go and read it. */
export interface ProviderSubscriptionRef {
  /** Our own row, when we have one. */
  providerSubscriptionId?: string | null;
  /** The provider's id for the subscription. */
  externalId?: string | null;
  /** Shopify: the shop's numeric id. Never the myshopify domain - see below. */
  externalShopId?: string | null;
  tenantId: string;
  billableEntityId: string;
  /** Which internal product this subscription pays for. */
  productKey: string;
}

export interface BeginSubscriptionInput {
  tenantId: string;
  billableEntityId: string;
  productKey: string;
  /** Internal plan being requested. */
  planKey?: string | null;
  planVersion?: number | null;
  /** The provider's own plan handle, from configuration. Never a price. */
  providerPlanHandle?: string | null;
  externalShopId?: string | null;
  shopDomain?: string | null;
  /**
   * Where the merchant comes back to. MUST already have been validated against
   * the allow-list by the caller - an adapter is not the place to decide
   * whether a redirect target is safe.
   */
  returnUrl: string;
  /** Idempotency for the create call itself, so a double-click makes one. */
  idempotencyKey: string;
  trialDays?: number | null;
}

export interface BeginSubscriptionResult {
  /**
   * Where to send the merchant. For Shopify App Pricing this is Shopify's
   * hosted plan-selection page; for the manual Billing API it is the
   * confirmationUrl from appSubscriptionCreate.
   *
   * Null means the source needs no merchant interaction at all (EXEMPT, FREE),
   * or - for GOTCHA_EXTERNAL - that the existing checkout owns that journey and
   * this port is not the thing that starts it.
   */
  redirectUrl: string | null;
  /** The provider's subscription id, when one exists this early. */
  externalId?: string | null;
  /**
   * What we believe right now. Almost always PENDING: nothing is confirmed
   * until fetchSubscription says so.
   */
  status: ProviderSubscriptionStatus;
}

/**
 * What the provider says is true, read from the provider.
 *
 * `rawStatus` is kept deliberately. Mapping into our enum is lossy, and the
 * provider's own word is what a support conversation and a reconciliation
 * mismatch both actually need.
 */
export interface ObservedSubscription {
  externalId: string | null;
  status: ProviderSubscriptionStatus;
  rawStatus: string | null;
  planHandle?: string | null;
  trialEndsAt?: Date | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  /** Redacted provider payload. Never a token, never a secret. */
  metadata?: Record<string, unknown>;
}

export interface UsageDispatchInput {
  /** The ledger row's id. Dispatch never invents usage; it only sends it. */
  ledgerEntryId: string;
  tenantId: string;
  externalShopId?: string | null;
  /** The provider's meter handle, from configuration. Case-sensitive. */
  meterHandle: string;
  quantity: string;
  occurredAt: Date;
  /**
   * The ledger row's idempotency key, sent verbatim. Shopify enforces its copy
   * permanently and caps it at 64 characters, so callers must stay inside that.
   */
  idempotencyKey: string;
}

export interface UsageReversalInput extends UsageDispatchInput {
  /** The entry being corrected. The reversal is a NEW row, never an edit. */
  reversalOfLedgerEntryId: string;
}

export interface UsageDispatchResult {
  accepted: boolean;
  providerEventId?: string | null;
  /**
   * True when the provider refused in a way a retry cannot fix - a timestamp
   * outside the billing cycle, a meter that does not exist. Distinct from a
   * transient failure, because retrying this one forever is just noise.
   */
  permanent?: boolean;
  failureCode?: string | null;
  failureReason?: string | null;
}

export interface BillingSourceProvider {
  readonly source: BillingSource;
  readonly capabilities: BillingSourceCapabilities;

  /**
   * Start the journey that MIGHT lead to a subscription. Never charges, never
   * activates, never grants an entitlement.
   */
  beginSubscription(input: BeginSubscriptionInput): Promise<BeginSubscriptionResult>;

  /**
   * Ask the provider what is actually true. The only source of activation.
   * Returns null when the provider has no such subscription - which is a real
   * answer, and means "revoke", not "leave things as they were".
   */
  fetchSubscription(ref: ProviderSubscriptionRef): Promise<ObservedSubscription | null>;

  /** Optional: not every source lets us cancel on the merchant's behalf. */
  cancelSubscription?(ref: ProviderSubscriptionRef): Promise<void>;

  /** Optional: absent when the source cannot meter usage at all. */
  dispatchUsage?(input: UsageDispatchInput): Promise<UsageDispatchResult>;
  reverseUsage?(input: UsageReversalInput): Promise<UsageDispatchResult>;
}

/** Raised when a source is asked to do something it is not verified to do. */
export class BillingSourceUnavailableError extends Error {
  constructor(readonly billingSource: BillingSource, readonly reason: string) {
    super(`[billing-source] ${billingSource} cannot proceed: ${reason}`);
    this.name = "BillingSourceUnavailableError";
  }
}
