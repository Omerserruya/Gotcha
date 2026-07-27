/**
 * Renewal, dunning and credit purchase under dual currency.
 *
 * The properties under test:
 *
 *   A renewal is converted at the rate in force AT RENEWAL, and records it. Two
 *   renewals a year apart should carry different shekel figures and each should
 *   still be explainable.
 *
 *   An outcome we do not know never enters the dunning ladder. Dunning retries;
 *   retrying a charge that may have landed bills someone twice for one month.
 *
 *   A retry charges the CONTRACTED price, not today's list price.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";

process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString("base64");

import { proposeRate, approveRate } from "../services/exchange-rate.service";
import { chargeFor } from "../services/invoice.service";
import { activateOrRenew } from "../services/subscription.service";
import { runDunning } from "../services/dunning.service";
import { SIM, resetSimulator } from "../providers/icount-simulator";
import { encryptPaymentToken } from "@chatcenter/shared";

const RUN = `rn-${Date.now()}`;
const PAIR = { base: "USD", quote: "ILS" };

const tenantIds: string[] = [];
const entityIds: string[] = [];
const rateIds: string[] = [];
let restoreRateId: string | null = null;
const ORIGINAL = { ...process.env };

async function setRate(value: string) {
  await prisma.billingExchangeRate.updateMany({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
    data: { status: "RETIRED" },
  });
  const draft = await proposeRate({ ...PAIR, rate: value, reason: "test seed", createdBy: `${RUN}-a` });
  rateIds.push(draft.id);
  return approveRate({ id: draft.id, approvedBy: `${RUN}-b` });
}

/** A tenant with a stored card whose behaviour the token prefix selects. */
async function tenantWithCard(tokenPrefix: string = SIM.OK) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });
  tenantIds.push(tenant.id);
  entityIds.push(entity.id);

  const profile = await prisma.billingProfile.create({
    data: { billableEntityId: entity.id, provider: "ICOUNT", providerCustomerId: "cli_rn" },
  });
  const sealed = encryptPaymentToken(`${tokenPrefix}_${n}`);
  await prisma.paymentMethod.create({
    data: {
      billingProfileId: profile.id,
      provider: "ICOUNT",
      token: sealed.ciphertext,
      tokenKeyVersion: sealed.keyVersion,
      brand: "visa",
      last4: "4242",
      isDefault: true,
      status: "ACTIVE",
    },
  });
  return { tenant, entityId: entity.id };
}

beforeAll(async () => {
  const existing = await prisma.billingExchangeRate.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
  });
  if (existing) {
    restoreRateId = existing.id;
    await prisma.billingExchangeRate.update({ where: { id: existing.id }, data: { status: "RETIRED" } });
  }
});

beforeEach(() => {
  process.env.ICOUNT_MODE = "simulator";
  process.env.ICOUNT_ALLOW_SIMULATOR = "true";
  delete process.env.ICOUNT_ALLOW_LIVE;
  resetSimulator();
});

afterAll(async () => {
  const invoices = await prisma.invoice.findMany({
    where: { billableEntityId: { in: entityIds } },
    select: { id: true },
  });
  await prisma.charge.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.dunningState.deleteMany({ where: { subscription: { billableEntityId: { in: entityIds } } } });
  await prisma.subscriptionEvent.deleteMany({
    where: { subscription: { billableEntityId: { in: entityIds } } },
  });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.paymentQuote.deleteMany({ where: { tenantId: { in: tenantIds } } });
  const profiles = await prisma.billingProfile.findMany({
    where: { billableEntityId: { in: entityIds } },
    select: { id: true },
  });
  await prisma.paymentMethod.deleteMany({ where: { billingProfileId: { in: profiles.map((p) => p.id) } } });
  await prisma.billingProfile.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
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

describe("a renewal is converted at the rate in force when it runs", () => {
  it("records the shekel figure and the rate on the charge", async () => {
    await setRate("3.65");
    const { tenant, entityId } = await tenantWithCard();

    const res = await chargeFor({
      entityId,
      tenantId: tenant.id,
      type: "SUBSCRIPTION",
      amount: 499,
      currency: "USD",
      description: "renewal",
      idempotencyKey: `${RUN}-renew-1`,
    });
    expect(res.success).toBe(true);

    const charge = await prisma.charge.findUnique({ where: { idempotencyKey: `${RUN}-renew-1` } });
    // Both figures survive. Keeping only one makes the other unanswerable.
    expect(new Prisma.Decimal(charge!.amount).toFixed(2)).toBe("499.00");
    expect(charge!.currency).toBe("USD");
    expect(new Prisma.Decimal(charge!.chargeAmount!).toFixed(2)).toBe("1821.35");
    expect(charge!.chargeCurrency).toBe("ILS");
    expect(charge!.providerCurrencyId).toBe(1);
    expect(new Prisma.Decimal(charge!.fxRate!).toFixed(2)).toBe("3.65");
    expect(charge!.fxRateVersion).toBeGreaterThan(0);
  });

  it("two renewals at different rates carry different shekel figures", async () => {
    const { tenant, entityId } = await tenantWithCard();

    await setRate("3.65");
    await chargeFor({
      entityId, tenantId: tenant.id, type: "SUBSCRIPTION", amount: 499, currency: "USD",
      description: "renewal", idempotencyKey: `${RUN}-renew-a`,
    });

    await setRate("4.00");
    await chargeFor({
      entityId, tenantId: tenant.id, type: "SUBSCRIPTION", amount: 499, currency: "USD",
      description: "renewal", idempotencyKey: `${RUN}-renew-b`,
    });

    const a = await prisma.charge.findUnique({ where: { idempotencyKey: `${RUN}-renew-a` } });
    const b = await prisma.charge.findUnique({ where: { idempotencyKey: `${RUN}-renew-b` } });
    expect(new Prisma.Decimal(a!.chargeAmount!).toFixed(2)).toBe("1821.35");
    expect(new Prisma.Decimal(b!.chargeAmount!).toFixed(2)).toBe("1996.00");
    // The earlier charge is untouched by the later rate change.
    expect(new Prisma.Decimal(a!.fxRate!).toFixed(2)).toBe("3.65");
    expect(a!.fxRateVersion).not.toBe(b!.fxRateVersion);
  });

  it("refuses to renew when no rate is approved, rather than guessing", async () => {
    await setRate("3.65");
    const { tenant, entityId } = await tenantWithCard();
    await prisma.billingExchangeRate.updateMany({
      where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
      data: { status: "RETIRED" },
    });

    const res = await chargeFor({
      entityId, tenantId: tenant.id, type: "SUBSCRIPTION", amount: 499, currency: "USD",
      description: "renewal", idempotencyKey: `${RUN}-renew-norate`,
    });
    expect(res.success).toBe(false);
    expect(res.failureCode).toMatch(/not_priceable/);
    // Notably it did NOT charge 499 shekels by treating the numbers as
    // interchangeable, which is the failure mode this whole design exists for.
    const charge = await prisma.charge.findUnique({ where: { idempotencyKey: `${RUN}-renew-norate` } });
    expect(charge!.status).toBe("FAILED");
    expect(charge!.chargeAmount).toBeNull();
  });

  it("an ILS-priced plan renews without needing an approved rate", async () => {
    await prisma.billingExchangeRate.updateMany({
      where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
      data: { status: "RETIRED" },
    });
    const { tenant, entityId } = await tenantWithCard();
    const res = await chargeFor({
      entityId, tenantId: tenant.id, type: "SUBSCRIPTION", amount: 1800, currency: "ILS",
      description: "renewal", idempotencyKey: `${RUN}-renew-ils`,
    });
    expect(res.success).toBe(true);
    const charge = await prisma.charge.findUnique({ where: { idempotencyKey: `${RUN}-renew-ils` } });
    expect(new Prisma.Decimal(charge!.chargeAmount!).toFixed(2)).toBe("1800.00");
    expect(new Prisma.Decimal(charge!.fxRate!).toNumber()).toBe(1);
  });
});

describe("an unknown outcome never enters the dunning ladder", () => {
  it("a timeout is recorded as UNKNOWN, not FAILED", async () => {
    await setRate("3.65");
    const { tenant, entityId } = await tenantWithCard(SIM.TIMEOUT);

    const res = await chargeFor({
      entityId, tenantId: tenant.id, type: "SUBSCRIPTION", amount: 499, currency: "USD",
      description: "renewal", idempotencyKey: `${RUN}-unknown-1`,
    });
    expect(res.success).toBe(false);
    // The distinction the whole thing turns on.
    expect(res.outcomeUnknown).toBe(true);

    const charge = await prisma.charge.findUnique({ where: { idempotencyKey: `${RUN}-unknown-1` } });
    expect(charge!.status).toBe("UNKNOWN");
  });

  it("a renewal with an unknown outcome does not become PAST_DUE", async () => {
    await setRate("3.65");
    const { entityId } = await tenantWithCard(SIM.TIMEOUT);
    const sub = await prisma.subscription.create({
      data: {
        billableEntityId: entityId,
        planKey: "ai_workforce",
        planVersion: 1,
        status: "ACTIVE",
        snapshotPrice: 499,
        snapshotCurrency: "USD",
        snapshotIncludedCredits: 2000,
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    });

    const res = await activateOrRenew(sub.id, { reason: "renewal" });
    expect(res.success).toBe(false);

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    // PAST_DUE would open a dunning record, and dunning retries. If the charge
    // actually landed, that retry is a second month's money.
    expect(after!.status).not.toBe("PAST_DUE");
    expect(await prisma.dunningState.findFirst({ where: { subscriptionId: sub.id } })).toBeNull();

    const events = await prisma.subscriptionEvent.findMany({ where: { subscriptionId: sub.id } });
    expect(events.map((e) => e.type)).toContain("renewal_outcome_unknown");
  });

  it("dunning stops rather than scheduling another retry after an unknown", async () => {
    await setRate("3.65");
    const { entityId } = await tenantWithCard(SIM.TIMEOUT);
    const sub = await prisma.subscription.create({
      data: {
        billableEntityId: entityId,
        planKey: "ai_workforce",
        planVersion: 1,
        status: "PAST_DUE",
        snapshotPrice: 499,
        snapshotCurrency: "USD",
        snapshotIncludedCredits: 2000,
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    });
    await prisma.dunningState.create({
      data: { subscriptionId: sub.id, stage: 0, attempts: 0, nextRetryAt: new Date(Date.now() - 1000) },
    });

    await runDunning(new Date());

    const state = await prisma.dunningState.findFirst({ where: { subscriptionId: sub.id } });
    // No next retry scheduled: the ladder is paused for a human, not advanced.
    expect(state?.nextRetryAt).toBeNull();
    const events = await prisma.subscriptionEvent.findMany({ where: { subscriptionId: sub.id } });
    expect(events.map((e) => e.type)).toContain("dunning_paused_outcome_unknown");
    // And it did not suspend them for a charge that may have succeeded.
    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(after!.status).toBe("PAST_DUE");
  });

  it("dunning retries at the contracted price, not today's list price", async () => {
    await setRate("3.65");
    const { entityId } = await tenantWithCard(SIM.DECLINE);
    const sub = await prisma.subscription.create({
      data: {
        billableEntityId: entityId,
        planKey: "ai_workforce",
        planVersion: 1,
        status: "PAST_DUE",
        // Grandfathered below list. A retry at list price would silently
        // re-price a customer whose only mistake was a failed card.
        snapshotPrice: 250,
        snapshotCurrency: "USD",
        snapshotIncludedCredits: 2000,
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    });
    await prisma.dunningState.create({
      data: { subscriptionId: sub.id, stage: 0, attempts: 0, nextRetryAt: new Date(Date.now() - 1000) },
    });

    await runDunning(new Date());

    const invoices = await prisma.invoice.findMany({ where: { billableEntityId: entityId } });
    const charges = await prisma.charge.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
    expect(charges.length).toBeGreaterThan(0);
    for (const c of charges) {
      expect(new Prisma.Decimal(c.amount).toFixed(2)).toBe("250.00");
      expect(new Prisma.Decimal(c.chargeAmount!).toFixed(2)).toBe("912.50");
    }
  });
});

describe("a charge already in flight is never re-submitted", () => {
  it("a duplicate idempotency key does not reach the provider again", async () => {
    await setRate("3.65");
    const { tenant, entityId } = await tenantWithCard();
    const key = `${RUN}-dup`;

    const first = await chargeFor({
      entityId, tenantId: tenant.id, type: "SUBSCRIPTION", amount: 499, currency: "USD",
      description: "renewal", idempotencyKey: key,
    });
    const second = await chargeFor({
      entityId, tenantId: tenant.id, type: "SUBSCRIPTION", amount: 499, currency: "USD",
      description: "renewal", idempotencyKey: key,
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.invoiceId).toBe(first.invoiceId);
    // One charge row, therefore one submission.
    const invoices = await prisma.invoice.findMany({ where: { billableEntityId: entityId } });
    const charges = await prisma.charge.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
    expect(charges).toHaveLength(1);
  });
});
