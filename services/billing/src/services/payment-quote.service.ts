/**
 * The frozen conversion between what was agreed and what is charged.
 *
 * A customer agrees to $499. iCount is told to take ₪1,821.35. Those are two
 * different numbers and both have to be defensible months later, so the rate,
 * its version, the source amount and the resulting ILS figure are captured
 * together at quote time and never recomputed.
 *
 * Recomputing at charge time would be the bug: the rate could have been changed
 * between the screen that showed a price and the request that takes the money,
 * and the customer would be charged something they never saw.
 *
 * A quote is single-use. One quote, one charge - enforced by a unique index on
 * the consuming attempt, so a retry cannot quietly bill twice at the same
 * frozen numbers.
 */
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";
import type { PaymentQuote } from "@prisma/client";
import { activeRate, convert, ROUNDING_MODE } from "./exchange-rate.service";

/**
 * iCount currency ids, from the verified contract. 1 = ILS, 2 = USD.
 *
 * Product policy pins every charge to ILS. USD submission stays unimplemented
 * rather than merely unused, so it cannot be switched on by changing a constant.
 */
export const ICOUNT_CURRENCY_ID = { ILS: 5, USD: 2 } as const;
export const CHARGE_CURRENCY = "ILS" as const;
export const CHARGE_CURRENCY_ID = ICOUNT_CURRENCY_ID.ILS;

/** Marks a quote where both sides are the same currency, so nothing converted. */
export const IDENTITY_SOURCE = "IDENTITY" as const;

/** How long a quoted rate stands. Long enough to pay, short enough to be honest. */
export const QUOTE_TTL_MS = 30 * 60 * 1000;

export type QuotePurpose =
  | "SUBSCRIPTION_INITIAL"
  | "RENEWAL"
  | "CREDIT_PACKAGE"
  | "AUTO_TOPUP"
  | "UPGRADE";

export class QuoteRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] payment quote refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "QuoteRefused";
  }
}

export interface CreateQuoteInput {
  purpose: QuotePurpose;
  commercialAmount: Prisma.Decimal.Value;
  commercialCurrency: string;
  tenantId?: string | null;
  checkoutId?: string | null;
  subscriptionId?: string | null;
  ttlMs?: number;
  now?: Date;
}

/**
 * Freeze a conversion.
 *
 * Fails closed when no approved rate exists. That is the deliberate consequence
 * of the design: until a Sysadmin configures and approves a rate, nothing can be
 * charged, because there is no defensible number to charge.
 */
export async function createPaymentQuote(input: CreateQuoteInput): Promise<PaymentQuote> {
  const now = input.now ?? new Date();
  const commercialCurrency = input.commercialCurrency.toUpperCase();

  const amount = new Prisma.Decimal(input.commercialAmount);
  if (!amount.isFinite() || amount.lte(0)) throw new QuoteRefused("amount_must_be_positive");

  // An ILS-priced plan charged in ILS involves no conversion, so there is no
  // rate to approve and none to pin. Demanding one would mean creating a fake
  // 1.0 row, which would be a lie in the audit trail.
  const identity = commercialCurrency === CHARGE_CURRENCY;

  const rate = identity ? null : await activeRate({ base: commercialCurrency, quote: CHARGE_CURRENCY, now });
  const chargeAmount = identity
    ? amount.toDecimalPlaces(2)
    : convert(amount, rate!.rate);
  if (chargeAmount.lte(0)) throw new QuoteRefused("charge_amount_not_positive");

  // Supersede any live quote for the same checkout. Two ACTIVE quotes would mean
  // two different truthful answers to "what will I be charged".
  if (input.checkoutId) {
    await prisma.paymentQuote.updateMany({
      where: { checkoutId: input.checkoutId, status: "ACTIVE" },
      data: { status: "SUPERSEDED" },
    });
  }

  return prisma.paymentQuote.create({
    data: {
      tenantId: input.tenantId ?? null,
      checkoutId: input.checkoutId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      purpose: input.purpose,
      commercialAmount: amount,
      commercialCurrency,
      // Pinned by id AND copied by value, so the numbers survive the rate row
      // being retired or corrected afterwards.
      fxRateId: rate?.id ?? null,
      fxRate: rate ? rate.rate : new Prisma.Decimal(1),
      fxRateSource: rate ? rate.source : IDENTITY_SOURCE,
      fxRateVersion: rate ? rate.version : 0,
      fxQuotedAt: now,
      chargeAmount,
      chargeCurrency: CHARGE_CURRENCY,
      providerCurrencyId: CHARGE_CURRENCY_ID,
      roundingMode: ROUNDING_MODE,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? QUOTE_TTL_MS)),
      status: "ACTIVE",
    },
  });
}

/** The live quote for a checkout, if one still stands. */
export async function activeQuoteForCheckout(
  checkoutId: string,
  now: Date = new Date(),
): Promise<PaymentQuote | null> {
  const quote = await prisma.paymentQuote.findFirst({
    where: { checkoutId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  if (!quote) return null;
  if (quote.expiresAt <= now) return null;
  return quote;
}

/**
 * The quote to charge against: reuse the live one, or freeze a fresh one.
 *
 * Reuse matters. Re-quoting on every page load would move the price under
 * someone who is mid-payment.
 */
export async function ensureQuoteForCheckout(input: {
  checkoutId: string;
  tenantId?: string | null;
  purpose?: QuotePurpose;
  commercialAmount: Prisma.Decimal.Value;
  commercialCurrency: string;
  now?: Date;
}): Promise<PaymentQuote> {
  const now = input.now ?? new Date();
  const existing = await activeQuoteForCheckout(input.checkoutId, now);
  if (
    existing &&
    new Prisma.Decimal(existing.commercialAmount).equals(new Prisma.Decimal(input.commercialAmount)) &&
    existing.commercialCurrency === input.commercialCurrency.toUpperCase()
  ) {
    return existing;
  }
  return createPaymentQuote({
    purpose: input.purpose ?? "SUBSCRIPTION_INITIAL",
    commercialAmount: input.commercialAmount,
    commercialCurrency: input.commercialCurrency,
    tenantId: input.tenantId ?? null,
    checkoutId: input.checkoutId,
    now,
  });
}

/**
 * Bind a quote to the attempt that is about to charge it.
 *
 * Atomic and conditional, so under a race exactly one attempt gets the quote and
 * the loser is told to stop rather than charging on a quote already in flight.
 */
export async function consumeQuote(input: {
  quoteId: string;
  attemptId: string;
  now?: Date;
}): Promise<PaymentQuote> {
  const now = input.now ?? new Date();
  const claimed = await prisma.paymentQuote.updateMany({
    where: { id: input.quoteId, status: "ACTIVE", consumedByAttemptId: null, expiresAt: { gt: now } },
    data: { status: "CONSUMED", consumedByAttemptId: input.attemptId, consumedAt: now },
  });

  if (claimed.count !== 1) {
    const current = await prisma.paymentQuote.findUnique({ where: { id: input.quoteId } });
    if (!current) throw new QuoteRefused("quote_not_found");
    // Re-entry by the same attempt is fine; that is a retry of our own work.
    if (current.consumedByAttemptId === input.attemptId) return current;
    if (current.expiresAt <= now) throw new QuoteRefused("quote_expired");
    throw new QuoteRefused("quote_already_consumed", current.status);
  }

  const quote = await prisma.paymentQuote.findUnique({ where: { id: input.quoteId } });
  return quote!;
}

/** Mark quotes past their TTL. Housekeeping only - expiry is enforced on read. */
export async function expireStaleQuotes(now: Date = new Date()): Promise<number> {
  const res = await prisma.paymentQuote.updateMany({
    where: { status: "ACTIVE", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return res.count;
}

/**
 * Everything that must hold before a quote may be submitted to the provider.
 *
 * Checked immediately before the call rather than trusted from quote time,
 * because the gap between the two is exactly where an expired or already-charged
 * quote would slip through.
 */
export function assertChargeable(quote: PaymentQuote, now: Date = new Date()): void {
  if (quote.chargeCurrency !== CHARGE_CURRENCY) {
    throw new QuoteRefused("charge_currency_not_ils", quote.chargeCurrency);
  }
  if (quote.providerCurrencyId !== CHARGE_CURRENCY_ID) {
    throw new QuoteRefused("provider_currency_id_not_ils", String(quote.providerCurrencyId));
  }
  if (new Prisma.Decimal(quote.chargeAmount).lte(0)) {
    throw new QuoteRefused("charge_amount_not_positive");
  }
  if (quote.expiresAt <= now) throw new QuoteRefused("quote_expired");
}

/**
 * Verify a quote still describes the checkout it belongs to, at activation.
 *
 * The commercial snapshot is the contract. If the quote no longer matches it,
 * something changed between agreement and payment and activating would hand out
 * a plan on terms nobody agreed to.
 */
export function assertQuoteMatchesCommercial(
  quote: PaymentQuote,
  commercial: { id?: string; amount: Prisma.Decimal.Value; currency: string },
): void {
  if (commercial.id && quote.checkoutId && quote.checkoutId !== commercial.id) {
    throw new QuoteRefused("quote_not_for_this_checkout");
  }
  if (!new Prisma.Decimal(quote.commercialAmount).equals(new Prisma.Decimal(commercial.amount))) {
    throw new QuoteRefused("quote_commercial_amount_mismatch");
  }
  if (quote.commercialCurrency !== commercial.currency.toUpperCase()) {
    throw new QuoteRefused("quote_commercial_currency_mismatch");
  }
  // Recompute from the frozen rate. Catches a tampered or corrupted charge
  // amount, which is the one field an attacker would want to change.
  if (quote.fxRateSource === IDENTITY_SOURCE) {
    if (quote.commercialCurrency !== quote.chargeCurrency) {
      throw new QuoteRefused("identity_quote_across_currencies");
    }
    if (!new Prisma.Decimal(quote.fxRate).equals(1)) throw new QuoteRefused("identity_quote_rate_not_one");
  }
  const expected = convert(quote.commercialAmount, quote.fxRate);
  if (!expected.equals(new Prisma.Decimal(quote.chargeAmount))) {
    throw new QuoteRefused("quote_charge_amount_inconsistent");
  }
}

/** What a customer is shown: both figures, plus the rate that connects them. */
export function quoteDisplay(quote: PaymentQuote) {
  return {
    commercialAmount: new Prisma.Decimal(quote.commercialAmount).toFixed(2),
    commercialCurrency: quote.commercialCurrency,
    chargeAmount: new Prisma.Decimal(quote.chargeAmount).toFixed(2),
    chargeCurrency: quote.chargeCurrency,
    fxRate: new Prisma.Decimal(quote.fxRate).toFixed(4),
    fxRateVersion: quote.fxRateVersion,
    quotedAt: quote.fxQuotedAt.toISOString(),
    expiresAt: quote.expiresAt.toISOString(),
  };
}
