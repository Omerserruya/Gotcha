/**
 * Payment provider abstraction — iCount today, Stripe/Paddle tomorrow.
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
  /** Amount in major currency units (e.g. 499.00 ILS). */
  amount: number;
  currency: string;
  description: string;
  /** Required for safe retries — the provider must dedupe on this. */
  idempotencyKey: string;
  /** When true, also issue a legal tax document (חשבונית מס) for the charge. */
  issueInvoice?: boolean;
  customer?: { email?: string; name?: string; vatId?: string };
}

export interface ChargeResult {
  success: boolean;
  providerChargeRef?: string;
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
}

export interface WebhookVerifyInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface PaymentProvider {
  readonly name: BillingProvider;
  /**
   * Confirm a PayPage tokenization server-side. For iCount this also reflects
   * the J5 (1₪) verification result; the auth is released by iCount's flow.
   * `pageToken` is the reference the hosted page returns to the client.
   */
  tokenizeAndVerify(input: { pageToken: string; customer?: { email?: string; name?: string } }): Promise<TokenizeResult>;
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(input: RefundInput): Promise<ChargeResult>;
  verifyWebhook(input: WebhookVerifyInput): boolean;
}
