/**
 * Payment provider abstraction - iCount today, Stripe/Paddle tomorrow.
 *
 * The billing domain NEVER touches raw card data: the provider's hosted page
 * (iCount PayPage) tokenizes; we store only the token + card metadata. Every
 * money operation goes through this interface so swapping providers is a config
 * change, not a rewrite.
 */
import type { BillingProvider } from "@prisma/client";

export interface TokenizeResult {
  /** Opaque token used for all future charges. NEVER a raw PAN. */
  token: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  /** Provider-side customer handle, if the provider issues one. */
  providerCustomerId?: string;
}

export interface ChargeInput {
  token: string;
  providerCustomerId?: string;
  /** Our own opaque customer reference, when the provider echoes one back. */
  customClientId?: string;
  /** The commercial amount the customer agreed to, for the record. */
  amount: number;
  currency: string;
  /**
   * What is actually submitted, as a decimal string from a frozen payment
   * quote. A string, not a number: a float amount is a rounding bug waiting
   * for the right price.
   */
  chargeAmount?: string;
  chargeCurrency?: string;
  /** The provider's own currency id. Never defaulted - see the quote. */
  providerCurrencyId?: number;
  description: string;
  /** Required for safe retries - the provider must dedupe on this. */
  idempotencyKey: string;
  /** When true, also issue a legal tax document (חשבונית מס) for the charge. */
  issueInvoice?: boolean;
  customer?: { email?: string; name?: string; vatId?: string };
}

export interface ChargeResult {
  success: boolean;
  providerChargeRef?: string;
  /**
   * The charge cannot be treated as either done or not done, so a human or a
   * lookup has to settle it. Distinct from `success: false`, which means no
   * money moved and a retry is safe.
   */
  requiresReconciliation?: boolean;
  /** Set on failure: provider/decline code for dunning + display. */
  failureCode?: string;
  /** Populated when issueInvoice was requested and succeeded. */
  providerInvoiceRef?: string;
  providerPdfUrl?: string;
}

export interface RefundInput {
  providerChargeRef: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  reason?: string;
  /**
   * iCount refunds are DOCUMENT-linked (doc/cancel), not charge-linked, so the
   * issued document is what actually gets cancelled. A charge with no document
   * cannot be refunded through that route.
   */
  providerInvoiceRef?: string;
  providerInvoiceDocType?: string;
  /**
   * The charge's full amount. Supplied so a provider that can only cancel a
   * whole document can REFUSE a partial refund rather than silently returning
   * more than was asked for.
   */
  expectedFullAmount?: number;
}

export interface WebhookVerifyInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface StartTokenizationInput {
  pageId: string;
  /** Our reference, echoed back so the session can be correlated server-side. */
  customClientId: string;
  clientName?: string;
  email?: string;
  successUrl?: string;
  failureUrl?: string;
  /** Where the customer lands if they abandon the hosted page. */
  cancelUrl?: string;
  ipnUrl?: string;
  /**
   * Our checkout reference, echoed into the provider's own records.
   *
   * A SECOND correlation handle, never the primary one: `customClientId` is the
   * verified field that survives the round trip and is what every lookup keys
   * on. This exists so a transaction is identifiable from the iCount side
   * during reconciliation, and nothing breaks if the provider ignores it.
   */
  orderId?: string;
}

export interface StartTokenizationResult {
  saleUrl: string;
  /**
   * The provider's own id for the customer this session belongs to.
   *
   * Established while starting the session - iCount will not create a client
   * during generate_sale, so one is created first and answers with an id. That
   * id is what a later charge is attributed to, so it has to travel back out
   * of here; discarding it left the charge with nothing to name and iCount
   * refusing it as unattributable.
   *
   * Optional because a provider that has no such concept is free to omit it.
   */
  providerClientId?: string;
  raw: unknown;
}

export interface StoredCardQuery {
  clientId?: string;
  customClientId?: string;
}

export interface StoredCard {
  token: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface PaymentProvider {
  readonly name: BillingProvider;
  /**
   * Read a hosted page's configuration, so the caller can confirm it stores a
   * card rather than charging for one.
   */
  describePaymentPage?(pageId: string): Promise<Record<string, unknown>>;
  /** Begin a hosted tokenization session. Returns where to send the customer. */
  startTokenization?(input: StartTokenizationInput): Promise<StartTokenizationResult>;
  /**
   * Ask the provider which cards it has stored.
   *
   * The only accepted proof that tokenization happened. A browser returning to
   * a success URL proves the customer came back and nothing more.
   */
  listStoredCards?(query: StoredCardQuery): Promise<StoredCard[]>;
  /**
   * Confirm a PayPage tokenization server-side. For iCount this also reflects
   * the J5 (1₪) verification result; the auth is released by iCount's flow.
   * `pageToken` is the reference the hosted page returns to the client.
   */
  tokenizeAndVerify(input: { pageToken: string; customer?: { email?: string; name?: string } }): Promise<TokenizeResult>;
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(input: RefundInput): Promise<ChargeResult>;
  /**
   * Ask the provider what actually happened to a charge whose outcome is
   * unknown - a timeout, or a crash between request and response. Optional:
   * not every provider offers a lookup.
   */
  lookupTransactions?(query: { token?: string; clientId?: string }): Promise<unknown>;
  verifyWebhook(input: WebhookVerifyInput): boolean;
}
