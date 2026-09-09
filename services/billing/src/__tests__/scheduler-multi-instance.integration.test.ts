/**
 * Two billing replicas ticking at the same moment.
 *
 * The scheduler carries a note saying it assumes a single instance and that
 * production should gate it with a leader lock. That note has been there
 * through every deploy, and nobody has checked what actually happens without
 * one - which is the uncomfortable kind of comment, because it describes a risk
 * rather than a mitigation.
 *
 * If it is genuinely unsafe, running two replicas double-charges every renewal
 * in the same hour. If it is safe, it is safe because the charge keys are
 * deterministic, and that deserves to be a tested property rather than a
 * fortunate accident nobody may refactor away.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";

process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 17).toString("base64");

import { encryptPaymentToken } from "@chatcenter/shared";
import { proposeRate, approveRate } from "../services/exchange-rate.service";
import { activateOrRenew } from "../services/subscription.service";
import { runDunning } from "../services/dunning.service";
import { SIM, resetSimulator } from "../providers/icount-simulator";

const RUN = `multi-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const rateIds: string[] = [];
let restoreRateId: string | null = null;
const ORIGINAL = { ...process.env };

async function ensureRate() {
  const active = await prisma.billingExchangeRate.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
  });
  if (active) return active;
  const draft = await proposeRate({ rate: "3.65", reason: "test seed", createdBy: `${RUN}-a` });
  rateIds.push(draft.id);
  return approveRate({ id: draft.id, approvedBy: `${RUN}-b` });
}

async function subscriber(opts: { token?: string; status?: any } = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });
  tenantIds.push(tenant.id);
  entityIds.push(entity.id);

  const profile = await prisma.billingProfile.create({
    // Declared country is mandatory before any charge (taxForProfile fails
    // closed). "US" has no TaxRate row, so tax is 0% and the amounts this file
    // asserts stay about renewal idempotency rather than VAT.
    data: { billableEntityId: entity.id, provider: "ICOUNT", providerCustomerId: "cli_multi", billingCountry: "US" },
  });
  const sealed = encryptPaymentToken(`${opts.token ?? SIM.OK}_${n}`);
  await prisma.paymentMethod.create({
    data: {
      billingProfileId: profile.id, provider: "ICOUNT",
      token: sealed.ciphertext, tokenKeyVersion: sealed.keyVersion,
      brand: "visa", last4: "4242", isDefault: true, status: "ACTIVE",
    },
  });

  const sub = await prisma.subscription.create({
    data: {
      billableEntityId: entity.id,
      planKey: "ai_workforce", planVersion: 1,
      status: opts.status ?? "ACTIVE",
      enforcementEnabled: true,
      snapshotPrice: 499, snapshotCurrency: "USD", snapshotIncludedCredits: 2000,
      currentPeriodStart: new Date(Date.now() - 40 * 86_400_000),
      currentPeriodEnd: new Date(Date.now() - 1000),
    },
  });
  return { tenant, entityId: entity.id, sub };
}

async function chargesFor(entityId: string) {
  const invoices = await prisma.invoice.findMany({ where: { billableEntityId: entityId }, select: { id: true } });
  return prisma.charge.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
}

beforeAll(async () => {
  const existing = await prisma.billingExchangeRate.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
  });
  if (existing) restoreRateId = existing.id;
  await ensureRate();
});

beforeEach(() => {
  process.env.ICOUNT_MODE = "simulator";
  process.env.ICOUNT_ALLOW_SIMULATOR = "true";
  delete process.env.ICOUNT_ALLOW_LIVE;
  resetSimulator();
});

afterAll(async () => {
  const invoices = await prisma.invoice.findMany({
    where: { billableEntityId: { in: entityIds } }, select: { id: true },
  });
  await prisma.charge.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.dunningState.deleteMany({ where: { subscription: { billableEntityId: { in: entityIds } } } });
  await prisma.subscriptionEvent.deleteMany({ where: { subscription: { billableEntityId: { in: entityIds } } } });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.paymentQuote.deleteMany({ where: { tenantId: { in: tenantIds } } });
  const profiles = await prisma.billingProfile.findMany({
    where: { billableEntityId: { in: entityIds } }, select: { id: true },
  });
  await prisma.paymentMethod.deleteMany({ where: { billingProfileId: { in: profiles.map((p) => p.id) } } });
  await prisma.billingProfile.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.billingExchangeRate.deleteMany({ where: { id: { in: rateIds } } });
  if (restoreRateId) {
    await prisma.billingExchangeRate
      .update({ where: { id: restoreRateId }, data: { status: "ACTIVE" } })
      .catch(() => undefined);
  }
  process.env = { ...ORIGINAL };
});

describe("two replicas renewing the same subscription", () => {
  it("charges the customer once", async () => {
    const { entityId, sub } = await subscriber();

    // Four replicas, same instant, same subscription. No leader lock.
    await Promise.all(
      Array.from({ length: 4 }, () => activateOrRenew(sub.id, { reason: "renewal" }).catch((e) => e)),
    );

    const charges = await chargesFor(entityId);
    // Safe because the idempotency key is derived from the subscription and the
    // period, not from the moment or the worker. That is the property holding
    // this together, and it is now a tested one.
    expect(charges).toHaveLength(1);
    expect(charges[0].status).toBe("SUCCEEDED");
  });

  it("grants the period's credits once", async () => {
    const { tenant, sub } = await subscriber();
    await Promise.all(
      Array.from({ length: 4 }, () => activateOrRenew(sub.id, { reason: "renewal" }).catch((e) => e)),
    );

    const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
    const granted = lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0);
    // Four replicas granting 2,000 each would be 8,000 credits given away.
    expect(granted).toBe(2000);
  });

  it("does not stack invoices", async () => {
    const { entityId, sub } = await subscriber();
    await Promise.all(
      Array.from({ length: 4 }, () => activateOrRenew(sub.id, { reason: "renewal" }).catch((e) => e)),
    );
    const invoices = await prisma.invoice.findMany({ where: { billableEntityId: entityId } });
    expect(invoices).toHaveLength(1);
  });
});

describe("two replicas running dunning at once", () => {
  it("retries a past-due subscription once, not once per replica", async () => {
    const { entityId, sub } = await subscriber({ token: SIM.DECLINE, status: "PAST_DUE" });
    await prisma.dunningState.create({
      data: { subscriptionId: sub.id, stage: 0, attempts: 0, nextRetryAt: new Date(Date.now() - 1000) },
    });

    await Promise.all(Array.from({ length: 3 }, () => runDunning(new Date()).catch((e) => e)));

    const charges = await chargesFor(entityId);
    // The dunning key includes the attempt number, and every replica reads the
    // same attempt count before any of them writes - so they collide on one key
    // rather than each opening a new attempt.
    expect(charges.length).toBeLessThanOrEqual(1);
  });

  it("does not advance the ladder once per replica", async () => {
    const { sub } = await subscriber({ token: SIM.DECLINE, status: "PAST_DUE" });
    await prisma.dunningState.create({
      data: { subscriptionId: sub.id, stage: 0, attempts: 0, nextRetryAt: new Date(Date.now() - 1000) },
    });

    await Promise.all(Array.from({ length: 3 }, () => runDunning(new Date()).catch((e) => e)));

    const state = await prisma.dunningState.findFirst({ where: { subscriptionId: sub.id } });
    // Three replicas each advancing a stage would suspend a customer after one
    // failed retry instead of after the whole ladder.
    expect(state?.stage ?? 0).toBeLessThanOrEqual(1);
  });
});

describe("an unknown outcome under two replicas", () => {
  it("still leaves exactly one charge to reconcile", async () => {
    const { entityId, sub } = await subscriber({ token: SIM.TIMEOUT });

    await Promise.all(
      Array.from({ length: 4 }, () => activateOrRenew(sub.id, { reason: "renewal" }).catch((e) => e)),
    );

    const charges = await chargesFor(entityId);
    // The dangerous combination: no leader lock AND an outcome nobody knows.
    // More than one charge here means several possible debits on one customer,
    // and no way to tell which of them landed.
    expect(charges).toHaveLength(1);
    expect(charges[0].status).toBe("UNKNOWN");
  });
});
