/**
 * The whole checkout, driven concurrently.
 *
 * Every piece has its own concurrency test - the attempt key, the execution
 * lease, the quote, the activation consume. This exercises the COMPOSITION,
 * which is where a payment system actually fails: each step is individually
 * safe and the sequence still charges someone twice.
 *
 * The scenario is ordinary, not exotic. Someone has the checkout open in two
 * tabs. Their phone and their laptop both poll. They refresh while the charge
 * is in flight. All of that arrives as concurrent `advanceCheckout` calls on one
 * checkout, and exactly one charge must come out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";

process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 13).toString("base64");

import { proposeRate, approveRate } from "../services/exchange-rate.service";
import { advanceCheckout, startPaymentSetup } from "../services/checkout-progress.service";
import { verifyTokenizationSession } from "../services/tokenization.service";
import { SIM, resetSimulator, simulateTokenization } from "../providers/icount-simulator";

const RUN = `conc-${Date.now()}`;
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
  const draft = await proposeRate({ rate: "3.65", reason: "test seed", createdBy: `${RUN}-a` });
  rateIds.push(draft.id);
  return approveRate({ id: draft.id, approvedBy: `${RUN}-b` });
}

/** A checkout with a card already stored, ready to be charged. */
async function readyToCharge(tokenPrefix: string = SIM.OK) {
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
      amount: 499, currency: "USD", status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: `checkout:chk_${n}`,
    },
  });
  checkoutIds.push(checkout.id);

  const { sessionId } = await startPaymentSetup(checkout.reference);
  const session = await prisma.tokenizationSession.findUnique({ where: { id: sessionId } });
  simulateTokenization(session!.customClientId, `${tokenPrefix}_${sessionId}`);
  await verifyTokenizationSession(sessionId);

  return { tenant, entityId: entity.id, checkout };
}

async function ledger(tenantId: string) {
  const lots = await prisma.aiUnitLot.findMany({ where: { tenantId } });
  return lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0);
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
  process.env.ICOUNT_PAYMENT_PAGE_ID = "12345";
  delete process.env.ICOUNT_ALLOW_LIVE;
  resetSimulator();
});

afterAll(async () => {
  await prisma.subscriptionEvent.deleteMany({
    where: { subscription: { billableEntityId: { in: entityIds } } },
  });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.paymentAttempt.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.paymentQuote.deleteMany({ where: { checkoutId: { in: checkoutIds } } });
  await prisma.tokenizationSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
  const profiles = await prisma.billingProfile.findMany({
    where: { billableEntityId: { in: entityIds } }, select: { id: true },
  });
  await prisma.paymentMethod.deleteMany({ where: { billingProfileId: { in: profiles.map((p) => p.id) } } });
  await prisma.billingProfile.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: checkoutIds } } });
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

describe("eight simultaneous customers of one checkout produce one charge", () => {
  it("charges once, activates once, grants credits once", async () => {
    const { tenant, entityId, checkout } = await readyToCharge();

    // Two tabs, a phone, a laptop, and a few impatient refreshes.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => advanceCheckout(checkout.reference).catch((e) => e)),
    );

    const paid = results.filter((r: any) => r?.phase === "PAID");
    expect(paid.length).toBeGreaterThan(0);

    // The four things that must each have happened exactly once.
    const attempts = await prisma.paymentAttempt.findMany({ where: { checkoutId: checkout.id } });
    expect(attempts, "one logical charge").toHaveLength(1);
    expect(attempts[0].state).toBe("SUCCEEDED");

    const consumedQuotes = await prisma.paymentQuote.count({
      where: { checkoutId: checkout.id, status: "CONSUMED" },
    });
    expect(consumedQuotes, "one frozen conversion charged").toBe(1);

    const subs = await prisma.subscription.count({ where: { billableEntityId: entityId } });
    expect(subs, "one subscription").toBe(1);

    expect(await ledger(tenant.id), "credits granted once").toBe(2000);

    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    // Paid once, so onboarding once: eight racing activations must not leave
    // the tenant anywhere other than the single post-payment state.
    expect(t?.status).toBe("PENDING_ONBOARDING");
  });

  it("stays at one charge when the calls are staggered mid-flight", async () => {
    const { tenant, checkout } = await readyToCharge();

    // Overlapping rather than simultaneous - a refresh landing while the first
    // charge is in flight, which a burst of identical calls can accidentally
    // serialise past.
    const staggered = Array.from({ length: 6 }, (_, i) =>
      new Promise((r) => setTimeout(r, i * 12)).then(() =>
        advanceCheckout(checkout.reference).catch((e) => e),
      ),
    );
    await Promise.all(staggered);

    expect(await prisma.paymentAttempt.count({ where: { checkoutId: checkout.id } })).toBe(1);
    expect(await ledger(tenant.id)).toBe(2000);
  });

  it("does not double-charge when a customer keeps clicking after it is paid", async () => {
    const { tenant, checkout } = await readyToCharge();
    await advanceCheckout(checkout.reference);

    const after = await Promise.all(
      Array.from({ length: 4 }, () => advanceCheckout(checkout.reference).catch((e) => e)),
    );
    // Every one of these is a no-op reporting the same completed state.
    expect(after.every((r: any) => r?.phase === "PAID")).toBe(true);
    expect(await prisma.paymentAttempt.count({ where: { checkoutId: checkout.id } })).toBe(1);
    expect(await ledger(tenant.id)).toBe(2000);
  });
});

describe("a decline under concurrency stays one decline", () => {
  it("produces one failed attempt, not one per caller", async () => {
    const { tenant, checkout } = await readyToCharge(SIM.DECLINE);

    await Promise.all(
      Array.from({ length: 6 }, () => advanceCheckout(checkout.reference).catch((e) => e)),
    );

    const attempts = await prisma.paymentAttempt.findMany({ where: { checkoutId: checkout.id } });
    // A retry key is minted only when EVERY existing attempt failed, so a burst
    // could in principle mint several. Measured across repeated runs: it does
    // not - the lease and the unique key serialise them into one.
    expect(attempts).toHaveLength(1);
    expect(attempts.every((a) => a.state === "FAILED")).toBe(true);
    // Nothing was provisioned.
    expect(await ledger(tenant.id)).toBe(0);
    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("PENDING_PAYMENT");
  });
});

describe("an unknown outcome under concurrency is still not retried", () => {
  it("leaves exactly one attempt, unresolved, and provisions nothing", async () => {
    const { tenant, checkout } = await readyToCharge(SIM.TIMEOUT);

    await Promise.all(
      Array.from({ length: 6 }, () => advanceCheckout(checkout.reference).catch((e) => e)),
    );

    const attempts = await prisma.paymentAttempt.findMany({ where: { checkoutId: checkout.id } });
    // The worst possible outcome would be several attempts here: the first may
    // have taken the money, and every extra one could take it again.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe("UNKNOWN");
    expect(await ledger(tenant.id)).toBe(0);

    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("PENDING_PAYMENT");
  });
});
