/**
 * Dual-currency payment: approved rate, frozen quote, activation invariant.
 *
 * The property under test throughout: the ILS figure taken from a card must be
 * one a person approved, must match the USD figure the customer agreed to, and
 * must still be explainable after the rate changes.
 *
 * DB-backed, because the guarantees here are unique indexes and conditional
 * updates - only the real database can prove those hold.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";
import {
  activeRate,
  approveRate,
  chargingRateConfigured,
  convert,
  proposeRate,
  retireRate,
  ExchangeRateUnavailable,
  ExchangeRateRefused,
} from "../services/exchange-rate.service";
import {
  CHARGE_CURRENCY,
  CHARGE_CURRENCY_ID,
  ICOUNT_CURRENCY_ID,
  assertChargeable,
  assertQuoteMatchesCommercial,
  consumeQuote,
  createPaymentQuote,
  ensureQuoteForCheckout,
  expireStaleQuotes,
  quoteDisplay,
  QuoteRefused,
} from "../services/payment-quote.service";
import { assertActivatable, ActivationRefused } from "../services/checkout-activation.service";

const RUN = `fx-${Date.now()}`;
// A test rate, not a production one. Production requires a Sysadmin to enter
// and approve a real figure; nothing here seeds one.
const TEST_RATE = "3.65000000";
const PAIR = { base: "USD", quote: "ILS" };

const rateIds: string[] = [];
const quoteIds: string[] = [];
const tenantIds: string[] = [];
const checkoutIds: string[] = [];

/** Isolate from any rate the environment already has, then restore it. */
let preexistingActiveId: string | null = null;

async function makeActiveRate(value = TEST_RATE) {
  const draft = await proposeRate({ ...PAIR, rate: value, createdBy: `${RUN}-author` });
  rateIds.push(draft.id);
  const active = await approveRate({ id: draft.id, approvedBy: `${RUN}-approver` });
  return active;
}

async function newCheckout(amount = 499) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  tenantIds.push(t.id);
  const c = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${n}`,
      tenantId: t.id,
      planKey: "ai_workforce",
      planVersion: 1,
      snapshotPrice: amount,
      snapshotCurrency: "USD",
      snapshotIncludedCredits: 2000,
      amount,
      currency: "USD",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: `checkout:chk_${n}`,
    },
  });
  checkoutIds.push(c.id);
  return { tenant: t, checkout: c };
}

/** A SUCCEEDED provider attempt wired to a quote, as the charge path would leave it. */
function attemptFor(checkout: any, quote: any, over: Record<string, any> = {}) {
  return {
    id: over.id ?? "att_1",
    checkoutId: checkout.id,
    tenantId: checkout.tenantId,
    amount: new Prisma.Decimal(checkout.amount),
    currency: "USD",
    state: "SUCCEEDED",
    paymentSource: "PROVIDER_CONFIRMED",
    consumedByActivationAt: null,
    paymentQuoteId: quote?.id ?? null,
    chargeAmount: quote ? new Prisma.Decimal(quote.chargeAmount) : null,
    chargeCurrency: quote?.chargeCurrency ?? null,
    providerCurrencyId: quote?.providerCurrencyId ?? null,
    ...over,
  } as any;
}

beforeAll(async () => {
  const existing = await prisma.billingExchangeRate.findFirst({
    where: { ...PAIR_WHERE(), status: "ACTIVE" },
  });
  if (existing) {
    preexistingActiveId = existing.id;
    await prisma.billingExchangeRate.update({ where: { id: existing.id }, data: { status: "RETIRED" } });
  }
});

function PAIR_WHERE() {
  return { baseCurrency: "USD", quoteCurrency: "ILS" };
}

afterAll(async () => {
  await prisma.paymentQuote.deleteMany({ where: { id: { in: quoteIds } } });
  await prisma.paymentQuote.deleteMany({ where: { checkoutId: { in: checkoutIds } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: checkoutIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.billingExchangeRate.deleteMany({ where: { id: { in: rateIds } } });
  if (preexistingActiveId) {
    await prisma.billingExchangeRate
      .update({ where: { id: preexistingActiveId }, data: { status: "ACTIVE" } })
      .catch(() => {});
  }
});

describe("the charging rate is approved, not fetched", () => {
  it("refuses to charge when no rate has been approved", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    // The whole point of failing closed: an unpriced charge is worse than a
    // blocked one.
    await expect(activeRate(PAIR)).rejects.toBeInstanceOf(ExchangeRateUnavailable);
    expect(await chargingRateConfigured(PAIR)).toBe(false);
  });

  it("a proposed rate is not yet chargeable", async () => {
    const draft = await proposeRate({ ...PAIR, rate: "3.99", createdBy: `${RUN}-a` });
    rateIds.push(draft.id);
    expect(draft.status).toBe("DRAFT");
    expect(draft.approvedBy).toBeNull();
    await expect(activeRate(PAIR)).rejects.toThrow(/no_active_rate/);
  });

  it("approval makes it chargeable and records who", async () => {
    const active = await makeActiveRate();
    expect(active.status).toBe("ACTIVE");
    expect(active.approvedBy).toBe(`${RUN}-approver`);
    expect(active.approvedAt).toBeTruthy();
    const found = await activeRate(PAIR);
    expect(found.id).toBe(active.id);
  });

  it("the approver cannot be the author", async () => {
    const draft = await proposeRate({ ...PAIR, rate: "3.70", createdBy: "same-person" });
    rateIds.push(draft.id);
    await expect(approveRate({ id: draft.id, approvedBy: "same-person" })).rejects.toThrow(
      /approver_must_differ_from_creator/,
    );
  });

  it("only one rate can be active for a pair", async () => {
    const first = await activeRate(PAIR);
    const second = await makeActiveRate("3.80");
    const actives = await prisma.billingExchangeRate.count({ where: { ...PAIR_WHERE(), status: "ACTIVE" } });
    // Two active rates would mean the charge amount depends on which row a
    // query happened to return first.
    expect(actives).toBe(1);
    expect(second.id).not.toBe(first.id);
    const retired = await prisma.billingExchangeRate.findUnique({ where: { id: first.id } });
    expect(retired?.status).toBe("RETIRED");
    expect(retired?.activeUntil).toBeTruthy();
  });

  it("the database refuses a second active row outright", async () => {
    const active = await activeRate(PAIR);
    const draft = await proposeRate({ ...PAIR, rate: "4.10", createdBy: `${RUN}-a` });
    rateIds.push(draft.id);
    // Bypassing approveRate must not be a way to get two live rates.
    await expect(
      prisma.billingExchangeRate.update({ where: { id: draft.id }, data: { status: "ACTIVE" } }),
    ).rejects.toThrow();
    expect((await activeRate(PAIR)).id).toBe(active.id);
  });

  it("rejects a rate that is obviously a typo", async () => {
    for (const bad of ["0", "-1", "3650"]) {
      await expect(proposeRate({ ...PAIR, rate: bad, createdBy: `${RUN}-a` })).rejects.toBeInstanceOf(
        ExchangeRateRefused,
      );
    }
  });

  it("a rate whose window has not opened is not the rate", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    const future = new Date(Date.now() + 86_400_000);
    const draft = await proposeRate({ ...PAIR, rate: "3.55", activeFrom: future, createdBy: `${RUN}-a` });
    rateIds.push(draft.id);
    await approveRate({ id: draft.id, approvedBy: `${RUN}-approver` });
    await expect(activeRate(PAIR)).rejects.toThrow(/no_active_rate/);
    // ...but it is the rate once its window opens.
    const later = await activeRate({ ...PAIR, now: new Date(future.getTime() + 1000) });
    expect(later.id).toBe(draft.id);
  });

  it("retiring stops charging without silently substituting anything", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    const active = await makeActiveRate();
    await retireRate({ id: active.id, actor: `${RUN}-a` });
    // Notably NOT falling back to the display rate's hardcoded 3.7.
    await expect(activeRate(PAIR)).rejects.toThrow(/no_active_rate/);
  });

  it("never reads the display rate path", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../services/exchange-rate.service.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of ["getUsdIlsRate", "refreshUsdIlsRate", "fxRateSnapshot", "fallbackUsdIls", "fetch("]) {
      expect(code, `payment rate must not use ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("conversion is exact decimal arithmetic", () => {
  it("multiplies and rounds half-up to two places", () => {
    expect(convert("499.00", "3.65").toFixed(2)).toBe("1821.35");
    expect(convert("100.00", "3.6667").toFixed(2)).toBe("366.67");
    // The half-up boundary, stated as a test because rounding money is policy.
    expect(convert("1.00", "3.005").toFixed(2)).toBe("3.01");
    expect(convert("1.00", "3.004").toFixed(2)).toBe("3.00");
  });

  it("does not drift the way binary floating point does", () => {
    // 0.1 + 0.2 !== 0.3 is the classic; the money version is a fraction of an
    // agora per charge that never reconciles.
    const exact = convert("0.10", "3").add(convert("0.20", "3"));
    expect(exact.toFixed(2)).toBe("0.90");
    expect(convert("29.99", "3.6512").toFixed(2)).toBe("109.50");
  });
});

describe("a quote freezes what will be charged", () => {
  it("records both figures and the rate that connects them", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    const rate = await makeActiveRate();
    const { tenant, checkout } = await newCheckout(499);

    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL",
      commercialAmount: 499,
      commercialCurrency: "USD",
      tenantId: tenant.id,
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);

    expect(new Prisma.Decimal(quote.commercialAmount).toFixed(2)).toBe("499.00");
    expect(quote.commercialCurrency).toBe("USD");
    expect(new Prisma.Decimal(quote.chargeAmount).toFixed(2)).toBe("1821.35");
    expect(quote.chargeCurrency).toBe("ILS");
    expect(quote.providerCurrencyId).toBe(1);
    expect(quote.fxRateId).toBe(rate.id);
    expect(quote.fxRateVersion).toBe(rate.version);
    expect(quote.roundingMode).toBe("HALF_UP");
  });

  it("survives the rate being changed afterwards", async () => {
    const { tenant, checkout } = await newCheckout(499);
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL",
      commercialAmount: 499, commercialCurrency: "USD",
      tenantId: tenant.id, checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);

    await makeActiveRate("4.20");

    const reread = await prisma.paymentQuote.findUnique({ where: { id: quote.id } });
    // The whole reason for copying the rate by value: the customer is charged
    // what they were shown, not what the rate happens to be at submit time.
    expect(new Prisma.Decimal(reread!.chargeAmount).toFixed(2)).toBe("1821.35");
    expect(new Prisma.Decimal(reread!.fxRate).toFixed(4)).toBe("3.6500");
  });

  it("fails closed when no rate is approved", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    const { tenant, checkout } = await newCheckout();
    await expect(
      createPaymentQuote({
        purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
        tenantId: tenant.id, checkoutId: checkout.id,
      }),
    ).rejects.toBeInstanceOf(ExchangeRateUnavailable);
  });

  it("reuses the live quote instead of re-pricing mid-payment", async () => {
    await makeActiveRate();
    const { tenant, checkout } = await newCheckout(499);
    const a = await ensureQuoteForCheckout({
      checkoutId: checkout.id, tenantId: tenant.id, commercialAmount: 499, commercialCurrency: "USD",
    });
    const b = await ensureQuoteForCheckout({
      checkoutId: checkout.id, tenantId: tenant.id, commercialAmount: 499, commercialCurrency: "USD",
    });
    expect(b.id).toBe(a.id);
    quoteIds.push(a.id);
  });

  it("supersedes the old quote when the agreed amount changes", async () => {
    const { tenant, checkout } = await newCheckout(499);
    const first = await ensureQuoteForCheckout({
      checkoutId: checkout.id, tenantId: tenant.id, commercialAmount: 499, commercialCurrency: "USD",
    });
    const second = await ensureQuoteForCheckout({
      checkoutId: checkout.id, tenantId: tenant.id, commercialAmount: 999, commercialCurrency: "USD",
    });
    quoteIds.push(first.id, second.id);
    expect(second.id).not.toBe(first.id);
    // Two live quotes would be two truthful answers to "what will I be charged".
    const stale = await prisma.paymentQuote.findUnique({ where: { id: first.id } });
    expect(stale?.status).toBe("SUPERSEDED");
    expect(await prisma.paymentQuote.count({ where: { checkoutId: checkout.id, status: "ACTIVE" } })).toBe(1);
  });

  it("is single-use under a concurrent race", async () => {
    const { tenant, checkout } = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      tenantId: tenant.id, checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        consumeQuote({ quoteId: quote.id, attemptId: `att-${i}` }).catch((e) => e),
      ),
    );
    const winners = results.filter((r: any) => r?.status === "CONSUMED" && !(r instanceof Error));
    // Exactly one attempt may charge against a frozen conversion.
    expect(winners).toHaveLength(1);
    expect(results.filter((r: any) => r instanceof QuoteRefused)).toHaveLength(5);
  });

  it("lets the same attempt re-enter, so a retry of our own work is safe", async () => {
    const { tenant, checkout } = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      tenantId: tenant.id, checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    const one = await consumeQuote({ quoteId: quote.id, attemptId: "att-same" });
    const two = await consumeQuote({ quoteId: quote.id, attemptId: "att-same" });
    expect(two.id).toBe(one.id);
  });

  it("refuses an expired quote rather than charging at a stale rate", async () => {
    const { tenant, checkout } = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      tenantId: tenant.id, checkoutId: checkout.id, ttlMs: -1000,
    });
    quoteIds.push(quote.id);
    await expect(consumeQuote({ quoteId: quote.id, attemptId: "att-late" })).rejects.toThrow(/quote_expired/);
    expect(() => assertChargeable(quote)).toThrow(/quote_expired/);
    expect(await expireStaleQuotes()).toBeGreaterThanOrEqual(1);
  });
});

describe("every charge is submitted in ILS", () => {
  it("pins the provider currency id to 1", () => {
    expect(CHARGE_CURRENCY).toBe("ILS");
    expect(CHARGE_CURRENCY_ID).toBe(1);
    expect(ICOUNT_CURRENCY_ID.ILS).toBe(1);
    expect(ICOUNT_CURRENCY_ID.USD).toBe(2);
  });

  it("refuses to submit anything that is not ILS", () => {
    const base: any = {
      chargeCurrency: "USD", providerCurrencyId: 2, chargeAmount: new Prisma.Decimal("499.00"),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(() => assertChargeable(base)).toThrow(/charge_currency_not_ils/);
    expect(() => assertChargeable({ ...base, chargeCurrency: "ILS" })).toThrow(/provider_currency_id_not_ils/);
  });

  it("detects a tampered charge amount", () => {
    const quote: any = {
      checkoutId: "chk1",
      commercialAmount: new Prisma.Decimal("499.00"), commercialCurrency: "USD",
      fxRate: new Prisma.Decimal("3.65"),
      // Recomputing from the frozen rate is what catches this.
      chargeAmount: new Prisma.Decimal("18213.50"),
    };
    expect(() => assertQuoteMatchesCommercial(quote, { id: "chk1", amount: 499, currency: "USD" })).toThrow(
      /quote_charge_amount_inconsistent/,
    );
  });

  it("shows the customer both figures and the rate between them", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    await makeActiveRate();
    const { tenant, checkout } = await newCheckout(499);
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      tenantId: tenant.id, checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    const d = quoteDisplay(quote);
    expect(d).toMatchObject({
      commercialAmount: "499.00", commercialCurrency: "USD",
      chargeAmount: "1821.35", chargeCurrency: "ILS", fxRate: "3.6500",
    });
  });
});

describe("an ILS-priced plan needs no conversion", () => {
  it("quotes at 1:1 without requiring an approved rate", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    const { tenant, checkout } = await newCheckout(499);
    // No USD->ILS rate is approved here. An ILS plan must still be chargeable.
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 1800, commercialCurrency: "ILS",
      tenantId: tenant.id, checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    expect(quote.fxRateSource).toBe("IDENTITY");
    expect(quote.fxRateId).toBeNull();
    expect(new Prisma.Decimal(quote.fxRate).toNumber()).toBe(1);
    expect(new Prisma.Decimal(quote.chargeAmount).toFixed(2)).toBe("1800.00");
    expect(quote.chargeCurrency).toBe("ILS");
  });

  it("the database refuses an identity quote that actually crosses currencies", async () => {
    const { checkout } = await newCheckout();
    // Otherwise "IDENTITY" would be a way to record a conversion with no rate.
    await expect(
      prisma.paymentQuote.create({
        data: {
          checkoutId: checkout.id, purpose: "SUBSCRIPTION_INITIAL",
          commercialAmount: 499, commercialCurrency: "USD",
          fxRateId: null, fxRate: 1, fxRateSource: "IDENTITY", fxRateVersion: 0,
          fxQuotedAt: new Date(), chargeAmount: 499, chargeCurrency: "ILS",
          providerCurrencyId: 1, expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it("the database refuses a converted quote with no rate reference", async () => {
    const { checkout } = await newCheckout();
    await expect(
      prisma.paymentQuote.create({
        data: {
          checkoutId: checkout.id, purpose: "SUBSCRIPTION_INITIAL",
          commercialAmount: 499, commercialCurrency: "USD",
          fxRateId: null, fxRate: "3.65", fxRateSource: "MANUAL_PLATFORM_RATE", fxRateVersion: 1,
          fxQuotedAt: new Date(), chargeAmount: "1821.35", chargeCurrency: "ILS",
          providerCurrencyId: 1, expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it("activation refuses an identity quote that pins a rate", async () => {
    await prisma.billingExchangeRate.updateMany({ where: PAIR_WHERE(), data: { status: "RETIRED" } });
    const rate = await makeActiveRate();
    const { checkout } = await newCheckout(499);
    const quote: any = {
      checkoutId: checkout.id,
      commercialAmount: new Prisma.Decimal("499.00"), commercialCurrency: "USD",
      fxRateId: rate.id, fxRate: new Prisma.Decimal(1), fxRateSource: "IDENTITY", fxRateVersion: 0,
      chargeAmount: new Prisma.Decimal("499.00"), chargeCurrency: "ILS", providerCurrencyId: 1,
      consumedByAttemptId: null,
    };
    expect(() => assertActivatable(checkout, attemptFor(checkout, quote), quote)).toThrow(
      /identity_quote_across_currencies/,
    );
  });
});

describe("activation verifies the frozen conversion", () => {
  it("activates when every figure lines up", async () => {
    const { checkout } = await newCheckout(499);
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    expect(() => assertActivatable(checkout, attemptFor(checkout, quote), quote)).not.toThrow();
  });

  it("refuses a provider payment with no quote at all", async () => {
    const { checkout } = await newCheckout();
    // Nothing would record which ILS figure was taken or at what rate.
    expect(() => assertActivatable(checkout, attemptFor(checkout, null), null)).toThrow(
      /provider_payment_without_quote/,
    );
  });

  it("refuses a quote belonging to a different checkout", async () => {
    const a = await newCheckout();
    const b = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      checkoutId: b.checkout.id,
    });
    quoteIds.push(quote.id);
    expect(() => assertActivatable(a.checkout, attemptFor(a.checkout, quote), quote)).toThrow(
      /quote_not_for_this_checkout/,
    );
  });

  it("refuses a quote already spent by another attempt", async () => {
    const { checkout } = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    const spent = { ...quote, consumedByAttemptId: "someone-else" } as any;
    // One frozen conversion must not activate two checkouts.
    expect(() => assertActivatable(checkout, attemptFor(checkout, quote), spent)).toThrow(
      /quote_consumed_by_other_attempt/,
    );
  });

  it("refuses when the submitted ILS amount differs from the quote", async () => {
    const { checkout } = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    const attempt = attemptFor(checkout, quote, { chargeAmount: new Prisma.Decimal("1800.00") });
    expect(() => assertActivatable(checkout, attempt, quote)).toThrow(/charge_amount_mismatch/);
  });

  it("refuses a charge submitted in the wrong currency", async () => {
    const { checkout } = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    expect(() =>
      assertActivatable(checkout, attemptFor(checkout, quote, { chargeCurrency: "USD" }), quote),
    ).toThrow(/charge_currency_mismatch/);
    expect(() =>
      assertActivatable(checkout, attemptFor(checkout, quote, { providerCurrencyId: 2 }), quote),
    ).toThrow(/provider_currency_id_not_ils/);
  });

  it("refuses when the commercial snapshot no longer matches the quote", async () => {
    const { checkout } = await newCheckout(499);
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 250, commercialCurrency: "USD",
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    const attempt = attemptFor(checkout, quote, { amount: new Prisma.Decimal("499.00") });
    // Activating here would grant a $499 plan against a $250 conversion.
    expect(() => assertActivatable(checkout, attempt, quote)).toThrow(/commercial_amount_mismatch/);
  });

  it("still refuses everything it refused before", async () => {
    const { checkout } = await newCheckout();
    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    // "We might have been paid" is still not payment.
    expect(() => assertActivatable(checkout, attemptFor(checkout, quote, { state: "UNKNOWN" }), quote)).toThrow(
      /attempt_not_succeeded/,
    );
    expect(() =>
      assertActivatable(checkout, attemptFor(checkout, quote, { consumedByActivationAt: new Date() }), quote),
    ).toThrow(/attempt_already_consumed/);
    expect(() => assertActivatable(checkout, attemptFor(checkout, quote), quote)).not.toThrow();
  });

  it("a manual contract carries no quote, and must not", async () => {
    const { checkout } = await newCheckout();
    const manual = attemptFor(checkout, null, {
      paymentSource: "MANUAL_EXTERNAL_CONTRACT", paymentQuoteId: null,
    });
    // No money moved through a provider, so there is nothing to convert.
    expect(() => assertActivatable(checkout, manual, null)).not.toThrow();

    const quote = await createPaymentQuote({
      purpose: "SUBSCRIPTION_INITIAL", commercialAmount: 499, commercialCurrency: "USD",
      checkoutId: checkout.id,
    });
    quoteIds.push(quote.id);
    expect(() =>
      assertActivatable(checkout, { ...manual, paymentQuoteId: quote.id }, quote),
    ).toThrow(/manual_contract_must_not_have_quote/);
  });

  it("refusals stay typed", async () => {
    const { checkout } = await newCheckout();
    expect(() => assertActivatable(checkout, attemptFor(checkout, null), null)).toThrow(ActivationRefused);
  });
});
