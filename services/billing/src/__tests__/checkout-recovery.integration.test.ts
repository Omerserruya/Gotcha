/**
 * Getting a stuck checkout unstuck.
 *
 * Two recovery stories that nothing else covers end to end:
 *
 *   A charge whose outcome was never learned is reconciled as SUCCEEDED, and
 *   the checkout then activates on THAT attempt - without charging again.
 *
 *   An emailed link keeps working. It is marked used on first use for the audit
 *   trail, but using it does not consume it: the waiting page polls, and a
 *   single-use link would break every checkout on the second request.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";

process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 11).toString("base64");

import { proposeRate, approveRate } from "../services/exchange-rate.service";
import { advanceCheckout } from "../services/checkout-progress.service";
import { reconcileUnknown } from "../services/payment-attempt.service";
import {
  issueContinuationLink,
  resolveContinuationLink,
  markLinkUsed,
} from "../services/continuation-link.service";
import type { PaymentProvider } from "../providers/provider";

const RUN = `rec2-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const checkoutIds: string[] = [];
const rateIds: string[] = [];
let restoreRateId: string | null = null;
const ORIGINAL = { ...process.env };

async function ensureRate() {
  const active = await prisma.billingExchangeRate.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
  });
  if (active) return active;
  const draft = await proposeRate({ rate: "3.65", createdBy: `${RUN}-a` });
  rateIds.push(draft.id);
  return approveRate({ id: draft.id, approvedBy: `${RUN}-b` });
}

async function scenario() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });
  tenantIds.push(tenant.id);
  entityIds.push(entity.id);

  const checkout = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${n}`, tenantId: tenant.id,
      planKey: "ai_workforce", planVersion: 1,
      snapshotPrice: 499, snapshotCurrency: "USD", snapshotIncludedCredits: 2000,
      amount: 499, currency: "USD", status: "AWAITING_PROVIDER",
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: `checkout:chk_${n}`,
    },
  });
  checkoutIds.push(checkout.id);
  return { tenant, entityId: entity.id, checkout };
}

/**
 * An attempt left in an unresolved state, as a mid-flight crash would leave it.
 *
 * Carries a real quote, because executeCharge binds one before anything is
 * submitted - an attempt without one could not have reached the provider, and
 * activation rightly refuses it.
 */
async function unknownAttempt(checkoutId: string, tenantId: string) {
  const rate = await ensureRate();
  const quote = await prisma.paymentQuote.create({
    data: {
      tenantId, checkoutId,
      purpose: "SUBSCRIPTION_INITIAL",
      commercialAmount: 499, commercialCurrency: "USD",
      fxRateId: rate.id, fxRate: rate.rate, fxRateSource: rate.source, fxRateVersion: rate.version,
      fxQuotedAt: new Date(),
      chargeAmount: "1821.35", chargeCurrency: "ILS", providerCurrencyId: 1,
      expiresAt: new Date(Date.now() + 3_600_000),
      status: "CONSUMED",
    },
  });
  const attempt = await prisma.paymentAttempt.create({
    data: {
      attemptKey: `checkout:chk_${Math.random().toString(36).slice(2, 10)}`,
      checkoutId, tenantId,
      purpose: "SUBSCRIPTION_INITIAL",
      amount: 499, currency: "USD",
      paymentQuoteId: quote.id,
      chargeAmount: "1821.35", chargeCurrency: "ILS", providerCurrencyId: 1,
      state: "UNKNOWN",
      providerRequestStartedAt: new Date(),
    },
  });
  await prisma.paymentQuote.update({
    where: { id: quote.id },
    data: { consumedByAttemptId: attempt.id, consumedAt: new Date() },
  });
  return attempt;
}

function providerReturning(transactions: Array<Record<string, unknown>>): PaymentProvider {
  return {
    name: "ICOUNT",
    async tokenizeAndVerify() { throw new Error("not used"); },
    async charge() { throw new Error("recovery must never charge"); },
    async refund() { throw new Error("not used"); },
    async lookupTransactions() { return { transactions }; },
    verifyWebhook() { return false; },
  };
}

beforeAll(async () => {
  const existing = await prisma.billingExchangeRate.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
  });
  if (existing) restoreRateId = existing.id;
  await ensureRate();
});

beforeEach(() => {
  process.env.ICOUNT_MODE = "mock";
  delete process.env.ICOUNT_ALLOW_LIVE;
});

afterAll(async () => {
  await prisma.paymentContinuationLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.paymentAttempt.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.paymentQuote.deleteMany({ where: { checkoutId: { in: checkoutIds } } });
  await prisma.tokenizationSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.subscriptionEvent.deleteMany({
    where: { subscription: { billableEntityId: { in: entityIds } } },
  });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: checkoutIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.billingExchangeRate.deleteMany({ where: { id: { in: rateIds } } });
  if (restoreRateId) {
    await prisma.billingExchangeRate
      .update({ where: { id: restoreRateId }, data: { status: "ACTIVE" } })
      .catch(() => {});
  }
  process.env = { ...ORIGINAL };
});

describe("a checkout stuck on an unknown outcome recovers", () => {
  it("shows needs-attention rather than a retryable failure", async () => {
    const { tenant, checkout } = await scenario();
    await unknownAttempt(checkout.id, tenant.id);

    const res = await advanceCheckout(checkout.reference);
    // Offering a retry here could charge them twice.
    expect(res.phase).toBe("NEEDS_ATTENTION");
  });

  it("activates on the reconciled attempt, without charging again", async () => {
    const { tenant, checkout, entityId } = await scenario();
    const attempt = await unknownAttempt(checkout.id, tenant.id);

    // The provider confirms the charge did land.
    const outcome = await reconcileUnknown({
      attemptId: attempt.id,
      provider: providerReturning([{ sum: 1821.35, confirmation_code: "conf_rec" }]),
      token: "tok",
    });
    expect(outcome.state).toBe("SUCCEEDED");

    const res = await advanceCheckout(checkout.reference);
    expect(res.phase).toBe("PAID");

    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("ACTIVE");
    const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
    expect(lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0)).toBe(2000);

    // Exactly one attempt: recovery activated the existing charge rather than
    // making a new one.
    expect(await prisma.paymentAttempt.count({ where: { checkoutId: checkout.id } })).toBe(1);
    expect(await prisma.subscription.count({ where: { billableEntityId: entityId } })).toBe(1);
  });

  it("prefers a succeeded attempt over a later failed one", async () => {
    const { tenant, checkout } = await scenario();
    const first = await unknownAttempt(checkout.id, tenant.id);
    await prisma.paymentAttempt.update({
      where: { id: first.id },
      data: { state: "SUCCEEDED", providerChargeRef: "conf_old" },
    });
    // A retry that failed AFTER the original succeeded - which is exactly what
    // reconciling an old UNKNOWN upward produces. Asking "what did the most
    // recent attempt do" would answer FAILED and charge again. A failed attempt
    // carries no quote, since nothing was ever settled against it.
    await prisma.paymentAttempt.create({
      data: {
        attemptKey: `checkout:${checkout.reference}:r1`,
        checkoutId: checkout.id, tenantId: tenant.id,
        purpose: "SUBSCRIPTION_INITIAL", amount: 499, currency: "USD",
        state: "FAILED", failureCode: "declined",
      },
    });

    const res = await advanceCheckout(checkout.reference);
    expect(res.phase).toBe("PAID");
    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("ACTIVE");
  });

  it("does not re-verify the card once the money is in", async () => {
    const { tenant, checkout } = await scenario();
    const attempt = await unknownAttempt(checkout.id, tenant.id);
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { state: "SUCCEEDED" } });
    // There is no tokenization session at all here. Re-checking the card after
    // a successful charge would only be a way to fail.
    expect(await prisma.tokenizationSession.count({ where: { tenantId: tenant.id } })).toBe(0);
    const res = await advanceCheckout(checkout.reference);
    expect(res.phase).toBe("PAID");
  });
});

describe("an emailed link keeps working", () => {
  it("resolves more than once, because the page polls", async () => {
    const { tenant, checkout } = await scenario();
    const link = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });

    const first = await resolveContinuationLink(link.token);
    expect(first.ok).toBe(true);
    if (first.ok) await markLinkUsed(first.link.id);

    // The waiting page polls every few seconds. A single-use link would 404 on
    // the second request and show "this link is no longer available" to someone
    // who is mid-payment.
    const second = await resolveContinuationLink(link.token);
    expect(second.ok).toBe(true);
    const third = await resolveContinuationLink(link.token);
    expect(third.ok).toBe(true);
  });

  it("records first use without consuming the link", async () => {
    const { tenant, checkout } = await scenario();
    const link = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
    const resolved = await resolveContinuationLink(link.token);
    if (!resolved.ok) throw new Error("expected the link to resolve");
    await markLinkUsed(resolved.link.id);

    const row = await prisma.paymentContinuationLink.findUnique({ where: { id: resolved.link.id } });
    // Used for the audit trail; still valid for the customer.
    expect(row?.usedAt).toBeTruthy();
    expect(row?.revokedAt).toBeNull();
    expect((await resolveContinuationLink(link.token)).ok).toBe(true);
  });

  it("stops working once revoked or expired", async () => {
    const { tenant, checkout } = await scenario();
    const link = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
    await prisma.paymentContinuationLink.updateMany({
      where: { checkoutId: checkout.id },
      data: { revokedAt: new Date() },
    });
    const res = await resolveContinuationLink(link.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("revoked");
  });

  it("still works after the payment succeeds", async () => {
    const { tenant, checkout } = await scenario();
    const link = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
    await prisma.pendingCheckout.update({ where: { id: checkout.id }, data: { status: "PAID" } });

    // The bug this guards against: the link died the instant the payment
    // succeeded, so the customer was redirected to the confirmation page, it
    // could not authorize, and they saw "this link is no longer available"
    // seconds after paying. The worst possible moment to show someone an error.
    const res = await resolveContinuationLink(link.token);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checkout.status).toBe("PAID");
  });

  it("still works for an expired checkout, so the page can explain", async () => {
    const { tenant, checkout } = await scenario();
    const link = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
    await prisma.pendingCheckout.update({ where: { id: checkout.id }, data: { status: "EXPIRED" } });
    // "This checkout expired, ask for a new link" is more use than the generic
    // unavailable state.
    expect((await resolveContinuationLink(link.token)).ok).toBe(true);
  });

  it("but a finished checkout cannot be advanced", async () => {
    const { checkout } = await scenario();
    await prisma.pendingCheckout.update({ where: { id: checkout.id }, data: { status: "CANCELED" } });
    // Viewing is not resuming. The guard moved, it did not disappear.
    await expect(advanceCheckout(checkout.reference)).rejects.toThrow(/checkout_canceled/);
  });

  it("nor can an expired one", async () => {
    const { checkout } = await scenario();
    await prisma.pendingCheckout.update({ where: { id: checkout.id }, data: { status: "EXPIRED" } });
    await expect(advanceCheckout(checkout.reference)).rejects.toThrow(/checkout_expired/);
  });

  it("issuing a new link retires the old one", async () => {
    const { tenant, checkout } = await scenario();
    const first = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
    await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
    // Otherwise a forwarded old email would still reach the checkout.
    const res = await resolveContinuationLink(first.token);
    expect(res.ok).toBe(false);
  });
});
