/**
 * Taking a payment - the self-serve checkout path.
 *
 * The other one is `chargeFor` in invoice.service, which renewals, plan
 * changes, credit purchases and auto top-ups use. The two claim and lease a
 * charge differently, and they should: a checkout is a person clicking Pay,
 * a renewal is a scheduler. What must NOT differ is what the customer ends up
 * holding, so tax and the tax document are shared code (tax-document.service)
 * rather than reimplemented here.
 *
 * The double-charge protections below are the reason this file exists: they
 * cannot be forgotten by a caller that only meant to add a small feature.
 *
 * The sequence, and why it is this order:
 *
 *   1. Claim the logical charge by a deterministic key. A second caller for the
 *      same charge collides here, across every billing instance.
 *   2. Take a time-bounded execution lease. Uniqueness stops two ROWS; the
 *      lease stops two WORKERS executing the one row.
 *   3. Only now freeze the conversion, and bind it to this attempt.
 *   4. Record that a provider request is about to start - BEFORE it starts, so
 *      a crash mid-flight is recoverable.
 *   5. Submit.
 *
 * Quoting comes AFTER the claim deliberately. Quoting first looked tidier, but
 * concurrent callers each froze a quote and each superseded the others - so the
 * one worker that had actually won the right to charge found its own quote
 * retired out from under it, and nobody could pay. Five clicks on a Pay button
 * is not an exotic scenario.
 *
 * The one rule that governs the whole file: an outcome we do not know is never
 * treated as an outcome we do. A decline can be retried. An unknown cannot.
 */
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";
import type { PaymentAttemptState } from "@prisma/client";
import { decryptPaymentToken } from "@chatcenter/shared";
import { getProvider, getCapabilities } from "../providers";
import {
  beginAttempt,
  claimExecution,
  markProviderRequestStarted,
  markProviderResponseReceived,
  releaseExecution,
  runAttempt,
  type AttemptPurpose,
} from "./payment-attempt.service";
import {
  assertChargeable,
  consumeQuote,
  createPaymentQuote,
  type QuotePurpose,
} from "./payment-quote.service";
import { taxForProfile } from "./tax.service";
import { issueTaxDocument, receiptIdentityForEntity } from "./tax-document.service";

export class ChargeRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] charge refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ChargeRefused";
  }
}

export interface ExecuteChargeInput {
  /**
   * Deterministic and derived from what is being paid for - never random.
   * A random key would make every retry a new logical charge, which is exactly
   * the double-charge this whole mechanism prevents.
   */
  attemptKey: string;
  purpose: AttemptPurpose & QuotePurpose;
  tenantId: string;
  checkoutId?: string | null;
  subscriptionId?: string | null;
  /** The agreed commercial figure, in the commercial currency. */
  commercialAmount: Prisma.Decimal.Value;
  commercialCurrency: string;
  description: string;
  /** Which stored card to charge. */
  paymentMethodId: string;
  providerCustomerId?: string | null;
  customClientId?: string | null;
  issueInvoice?: boolean;
  owner?: string;
  now?: Date;
}

export interface ExecuteChargeResult {
  state: PaymentAttemptState;
  attemptId: string;
  paymentQuoteId?: string;
  chargeAmount?: string;
  chargeCurrency?: string;
  providerChargeRef?: string;
  failureCode?: string;
  /** True when this call did the charging; false when it found existing work. */
  executed: boolean;
}

/** The single entry point for moving money. */
export async function executeCharge(input: ExecuteChargeInput): Promise<ExecuteChargeResult> {
  const now = input.now ?? new Date();
  const owner = input.owner ?? `${process.pid}:${process.env.HOSTNAME ?? "local"}`;

  const method = await prisma.paymentMethod.findUnique({
    where: { id: input.paymentMethodId },
    // The profile comes with it: it carries the billable entity the receipt is
    // made out to, and the country without which the charge cannot be priced.
    include: { profile: true },
  });
  if (!method) throw new ChargeRefused("payment_method_not_found");
  if (method.status !== "ACTIVE") throw new ChargeRefused("payment_method_not_active", method.status);

  const attemptKey = await keyForThisTry(input.attemptKey);

  const { created, attempt } = await beginAttempt({
    attemptKey,
    purpose: input.purpose,
    amount: Number(new Prisma.Decimal(input.commercialAmount)),
    currency: input.commercialCurrency.toUpperCase(),
    tenantId: input.tenantId,
    checkoutId: input.checkoutId ?? null,
  });

  if (!created) {
    // This logical charge already exists. Whatever state it is in, charging
    // again is not the answer - an UNKNOWN in particular is a reason to
    // reconcile, not to try once more.
    return {
      state: attempt.state,
      attemptId: attempt.id,
      providerChargeRef: attempt.providerChargeRef ?? undefined,
      failureCode: attempt.failureCode ?? undefined,
      executed: false,
    };
  }

  const claim = await claimExecution({ attemptId: attempt.id, owner });
  if (!claim.claimed) {
    // Another worker holds the lease. Uniqueness alone would not have stopped
    // this: both instances can find the same row and both decide to charge it.
    return { state: attempt.state, attemptId: attempt.id, executed: false };
  }

  let quote;
  let chargeAmount: string;
  let taxed;
  let identity;
  try {
    // Freeze the conversion now that this worker holds the exclusive right to
    // charge, so no other caller can retire it before it is used.
    quote = await createPaymentQuote({
      purpose: input.purpose,
      commercialAmount: input.commercialAmount,
      commercialCurrency: input.commercialCurrency,
      tenantId: input.tenantId,
      checkoutId: input.checkoutId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      now,
    });
    assertChargeable(quote, now);

    // Tax, on the CONVERTED net. This is the customer's FIRST payment, so a
    // net charge here is the one that most reliably goes unnoticed: nobody has
    // a previous invoice to compare it against. Computing it before conversion
    // would round twice and leave net + tax not equalling gross, which is a
    // document whose own three numbers disagree.
    //
    // Throws when no country has been declared, and that refusal is the point:
    // charging net would leave an Israeli customer owing VAT nobody collected.
    identity = await receiptIdentityForEntity(method.profile.billableEntityId);
    taxed = await taxForProfile(new Prisma.Decimal(quote.chargeAmount).toFixed(2), {
      billingCountry: identity?.billingCountry ?? null,
    });
    chargeAmount = taxed.gross;

    // Bound to the attempt BEFORE any request goes out, so a crash mid-flight
    // leaves a row that says exactly what was going to be submitted - which is
    // what reconciliation needs to search for.
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        paymentQuoteId: quote.id,
        chargeAmount: taxed.gross,
        netAmount: taxed.net,
        taxPercent: taxed.percent,
        taxAmount: taxed.tax,
        chargeCurrency: quote.chargeCurrency,
        providerCurrencyId: quote.providerCurrencyId,
      },
    });
    await consumeQuote({ quoteId: quote.id, attemptId: attempt.id, now });
  } catch (err) {
    // Nothing was submitted, so this attempt never happened as a charge.
    // Releasing it lets a corrected retry reuse the same logical key.
    await releaseExecution({ attemptId: attempt.id, owner }).catch(() => {});
    await prisma.paymentAttempt.delete({ where: { id: attempt.id } }).catch(() => {});
    throw err;
  }

  try {
    // Written BEFORE the request. If the process dies immediately after, the
    // row still says a request was in flight, and lease expiry will route it to
    // reconciliation instead of releasing it for a retry.
    await markProviderRequestStarted({ attemptId: attempt.id, owner });

    const result = await runAttempt({
      attemptId: attempt.id,
      provider: getProvider(method.provider),
      capabilities: getCapabilities(method.provider),
      charge: {
        token: decryptPaymentToken(method.token),
        providerCustomerId: input.providerCustomerId ?? undefined,
        customClientId: input.customClientId ?? undefined,
        amount: Number(new Prisma.Decimal(input.commercialAmount)),
        currency: input.commercialCurrency.toUpperCase(),
        chargeAmount,
        chargeCurrency: quote.chargeCurrency,
        providerCurrencyId: quote.providerCurrencyId,
        description: input.description,
        idempotencyKey: attemptKey,
        issueInvoice: input.issueInvoice,
      },
    });

    await markProviderResponseReceived({ attemptId: attempt.id, owner }).catch(() => {});

    // The tax document, once the money has actually moved.
    //
    // cc/bill takes money and issues nothing - its documented parameters
    // contain no field that would produce a document - so this is a second
    // call, and it has to come after, because a receipt for a charge that then
    // declined is a document for money nobody paid. It can never fail the
    // charge: the money is gone, and reporting an error would tell the caller
    // to retry a completed payment.
    if (result.state === "SUCCEEDED" && method.provider === "ICOUNT" && identity) {
      const doc = await issueTaxDocument({
        tenantId: input.tenantId,
        identity,
        description: input.description,
        currencyId: quote.providerCurrencyId,
        net: taxed.net,
        vatPercent: taxed.percent,
        gross: taxed.gross,
        confirmationCode: result.result?.providerChargeRef,
        cardBrand: method.brand,
        cardLast4: method.last4,
      });
      if (doc) {
        await prisma.paymentAttempt
          .update({
            where: { id: attempt.id },
            data: { documentRef: doc.docNumber, documentUrl: doc.docUrl },
          })
          .catch(() => {});
      }
    }

    return {
      state: result.state,
      attemptId: attempt.id,
      paymentQuoteId: quote.id,
      chargeAmount,
      chargeCurrency: quote.chargeCurrency,
      providerChargeRef: result.result?.providerChargeRef,
      failureCode: result.failureCode ?? result.result?.failureCode,
      executed: true,
    };
  } finally {
    // Releasing the lease is safe in every outcome: the attempt's own state
    // decides what may happen next, and a SUCCEEDED or UNKNOWN row will not be
    // re-executed regardless of who holds the lease.
    await releaseExecution({ attemptId: attempt.id, owner }).catch(() => {});
  }
}

/**
 * Whether a state may be charged again.
 *
 * Deliberately a small allowlist rather than a denylist of bad states: a new
 * state added later defaults to "do not retry", which is the safe direction.
 */
export function chargeableAgain(state: PaymentAttemptState): boolean {
  return state === "FAILED";
}

/** How many times one logical charge may be retried after a decline. */
export const MAX_RETRIES_AFTER_FAILURE = 5;

/**
 * The key for THIS attempt at a logical charge.
 *
 * The base key is deterministic, which is what stops a double-click becoming
 * two charges. But it also meant a declined customer could never pay again:
 * the key stayed occupied by the FAILED attempt forever, so every subsequent
 * try - even on a different card - returned the original decline. Someone
 * whose card was declined once was permanently unable to buy anything.
 *
 * Retrying after FAILED is safe precisely because FAILED is the state that
 * means the provider said no and no money moved. That is the whole reason it is
 * kept distinct from UNKNOWN. So a fresh key is minted only when EVERY existing
 * attempt for this charge failed; a single PENDING, SUCCEEDED, UNKNOWN or
 * RECONCILIATION_REQUIRED among them and the base key is returned unchanged, so
 * the caller gets that state back and does not charge.
 */
async function keyForThisTry(baseKey: string): Promise<string> {
  const existing = await prisma.paymentAttempt.findMany({
    where: { OR: [{ attemptKey: baseKey }, { attemptKey: { startsWith: `${baseKey}:r` } }] },
    select: { attemptKey: true, state: true },
  });
  if (!existing.length) return baseKey;

  // One non-failed attempt anywhere in the chain means this charge is settled
  // or in flight. Return the base key so beginAttempt reports it.
  if (!existing.every((a) => a.state === "FAILED")) return baseKey;

  if (existing.length > MAX_RETRIES_AFTER_FAILURE) {
    // Stop minting keys. Repeated declines are a conversation to have with the
    // customer, not something to keep hammering the provider about.
    return baseKey;
  }
  return `${baseKey}:r${existing.length}`;
}
