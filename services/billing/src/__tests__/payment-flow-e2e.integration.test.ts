/**
 * The whole payment path, against the simulator.
 *
 * Tokenize a card, charge it in ILS at an approved rate, activate the plan -
 * and then every way that goes wrong: a decline, a timeout after submission, a
 * success with no reference, a stale session, a concurrent double-submit.
 *
 * Those failure paths are the reason the simulator exists. They cannot be
 * produced on demand against a real payments API, so without it the code that
 * handles them would ship untested and first run during an incident.
 *
 * No network calls. No live mode. Nothing here can charge anything.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";
import { proposeRate, approveRate } from "../services/exchange-rate.service";
import { executeCharge, chargeableAgain } from "../services/charge-execution.service";
import {
  startTokenizationSession,
  verifyTokenizationSession,
  fingerprint,
  expireStaleSessions,
  MAX_VERIFICATION_ATTEMPTS,
} from "../services/tokenization.service";
import { activatePaidCheckout } from "../services/checkout-activation.service";
import { SIM, resetSimulator, simulateTokenization } from "../providers/icount-simulator";

// Set before anything imports the crypto module, which reads the key lazily but
// is easier to reason about when the value exists from the first line.
process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");

const RUN = `e2e-${Date.now()}`;
const TEST_RATE = "3.65000000"; // A test rate. No production rate is seeded.
const PAIR = { base: "USD", quote: "ILS" };

const tenantIds: string[] = [];
const checkoutIds: string[] = [];
const rateIds: string[] = [];
let restoreActiveRateId: string | null = null;
const ORIGINAL = { ...process.env };

async function seedApprovedRate() {
  const draft = await proposeRate({ ...PAIR, rate: TEST_RATE, createdBy: `${RUN}-author` });
  rateIds.push(draft.id);
  return approveRate({ id: draft.id, approvedBy: `${RUN}-approver` });
}

async function newTenantWithCheckout(amount = 499) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  tenantIds.push(tenant.id);
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });
  const checkout = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${n}`,
      tenantId: tenant.id,
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
  checkoutIds.push(checkout.id);
  return { tenant, checkout, entityId: entity.id };
}

/** Run the hosted-page half: start a session, store a card, verify server-side. */
async function tokenize(tenantId: string, checkoutId: string, tokenPrefix: string = SIM.OK) {
  const { session } = await startTokenizationSession({ tenantId, checkoutId });
  simulateTokenization(session.customClientId, `${tokenPrefix}_${session.id}`);
  const verified = await verifyTokenizationSession(session.id);
  if (!verified.verified) throw new Error(`tokenization did not verify: ${verified.reason}`);
  return { session, paymentMethodId: verified.paymentMethodId };
}

beforeAll(async () => {
  const existing = await prisma.billingExchangeRate.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
  });
  if (existing) {
    restoreActiveRateId = existing.id;
    await prisma.billingExchangeRate.update({ where: { id: existing.id }, data: { status: "RETIRED" } });
  }
  await seedApprovedRate();
});

beforeEach(() => {
  process.env.ICOUNT_MODE = "simulator";
  process.env.ICOUNT_ALLOW_SIMULATOR = "true";
  process.env.ICOUNT_PAYMENT_PAGE_ID = "12345";
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
    process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
  delete process.env.ICOUNT_ALLOW_LIVE;
  resetSimulator();
});

afterAll(async () => {
  const profiles = await prisma.billingProfile.findMany({
    where: { entity: { tenants: { some: { tenantId: { in: tenantIds } } } } },
    select: { id: true },
  });
  await prisma.paymentMethod.deleteMany({ where: { billingProfileId: { in: profiles.map((p) => p.id) } } });
  await prisma.tokenizationSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.paymentAttempt.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.paymentQuote.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.paymentQuote.deleteMany({ where: { checkoutId: { in: checkoutIds } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: checkoutIds } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.billingExchangeRate.deleteMany({ where: { id: { in: rateIds } } });
  if (restoreActiveRateId) {
    await prisma.billingExchangeRate
      .update({ where: { id: restoreActiveRateId }, data: { status: "ACTIVE" } })
      .catch(() => {});
  }
  process.env = { ...ORIGINAL };
});

describe("a customer pays and the plan goes live", () => {
  it("tokenizes, charges $499 as 1821.35 ILS, and activates", async () => {
    const { tenant, checkout, entityId } = await newTenantWithCheckout(499);
    const { paymentMethodId } = await tokenize(tenant.id, checkout.id);

    const res = await executeCharge({
      attemptKey: `checkout:${checkout.reference}`,
      purpose: "SUBSCRIPTION_INITIAL",
      tenantId: tenant.id,
      checkoutId: checkout.id,
      commercialAmount: 499,
      commercialCurrency: "USD",
      description: "AI Workforce",
      paymentMethodId,
      providerCustomerId: "cli_e2e",
    });

    expect(res.state).toBe("SUCCEEDED");
    expect(res.executed).toBe(true);
    // The customer agreed $499; the card was charged in shekels.
    expect(res.chargeAmount).toBe("1821.35");
    expect(res.chargeCurrency).toBe("ILS");
    expect(res.providerChargeRef).toBeTruthy();

    const activated = await activatePaidCheckout({
      checkoutId: checkout.id,
      paymentAttemptId: res.attemptId,
    });
    expect(activated.firstActivation).toBe(true);

    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("ACTIVE");
    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
    expect(sub?.status).toBe("ACTIVE");
    // The plan is still recorded at its USD price - conversion is a payment
    // detail, not a change to what was sold.
    expect(Number(sub?.snapshotPrice)).toBe(499);
    expect(sub?.snapshotCurrency).toBe("USD");

    const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
    expect(lots.reduce((n, l) => n + Number(l.unitsGranted ?? 0), 0)).toBe(2000);
  });

  it("stores the card encrypted, never in the clear", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { paymentMethodId, session } = await tokenize(tenant.id, checkout.id);

    const method = await prisma.paymentMethod.findUnique({ where: { id: paymentMethodId } });
    expect(method?.token).not.toContain(SIM.OK);
    expect(method?.tokenKeyVersion).toBeTruthy();
    expect(method?.last4).toBe("4242");
    // The session keeps only a hash, so a card reference exists in exactly one
    // place rather than two.
    const stored = await prisma.tokenizationSession.findUnique({ where: { id: session.id } });
    expect(stored?.resolvedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(SIM.OK);
  });

  it("charges the same checkout only once, however many times it is submitted", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { paymentMethodId } = await tokenize(tenant.id, checkout.id);

    const args = {
      attemptKey: `checkout:${checkout.reference}`,
      purpose: "SUBSCRIPTION_INITIAL" as const,
      tenantId: tenant.id,
      checkoutId: checkout.id,
      commercialAmount: 499,
      commercialCurrency: "USD",
      description: "AI Workforce",
      paymentMethodId,
      providerCustomerId: "cli_e2e",
    };

    const results = await Promise.all(Array.from({ length: 5 }, () => executeCharge(args).catch((e) => e)));
    const executed = results.filter((r: any) => r?.executed === true);
    // The whole point of the deterministic key plus the lease.
    expect(executed).toHaveLength(1);

    const attempts = await prisma.paymentAttempt.count({ where: { checkoutId: checkout.id } });
    expect(attempts).toBe(1);
    const consumed = await prisma.paymentQuote.count({
      where: { checkoutId: checkout.id, status: "CONSUMED" },
    });
    expect(consumed).toBe(1);
  });
});

describe("tokenization only counts a card this session actually stored", () => {
  it("does not accept a card the customer already had", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();

    // First session stores a card.
    const first = await startTokenizationSession({ tenantId: tenant.id, checkoutId: checkout.id });
    simulateTokenization(first.session.customClientId, `${SIM.OK}_first`);
    expect((await verifyTokenizationSession(first.session.id)).verified).toBe(true);

    // A second session sees that card in its baseline, so finding it again is
    // not evidence that anything happened this time.
    const second = await startTokenizationSession({ tenantId: tenant.id, checkoutId: checkout.id });
    await prisma.tokenizationSession.update({
      where: { id: second.session.id },
      data: { baselineFingerprints: [fingerprint(`${SIM.OK}_first`)] },
    });
    simulateTokenization(second.session.customClientId, `${SIM.OK}_first`);

    const res = await verifyTokenizationSession(second.session.id);
    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe("no_new_card_yet");
  });

  it("reports not-yet rather than failure while the customer is still paying", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { session } = await startTokenizationSession({ tenantId: tenant.id, checkoutId: checkout.id });
    // Customer is on the hosted page; nothing stored yet.
    const res = await verifyTokenizationSession(session.id);
    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe("no_new_card_yet");
    expect(res.session.status).toBe("AWAITING_RETURN");
  });

  it("gives up as abandoned, not failed, when the customer never finishes", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { session } = await startTokenizationSession({ tenantId: tenant.id, checkoutId: checkout.id });
    await prisma.tokenizationSession.update({
      where: { id: session.id },
      data: { verificationAttempts: MAX_VERIFICATION_ATTEMPTS },
    });
    const res = await verifyTokenizationSession(session.id);
    expect(res.verified).toBe(false);
    // Abandoning is a choice, not an error to show someone.
    expect(res.session.status).toBe("ABANDONED");
  });

  it("expires a session nobody came back to", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { session } = await startTokenizationSession({ tenantId: tenant.id, checkoutId: checkout.id });
    await prisma.tokenizationSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await verifyTokenizationSession(session.id);
    expect(res.verified).toBe(false);
    if (!res.verified) expect(res.reason).toBe("expired");
    expect(await expireStaleSessions()).toBeGreaterThanOrEqual(0);
  });

  it("two concurrent polls store exactly one card", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { session } = await startTokenizationSession({ tenantId: tenant.id, checkoutId: checkout.id });
    simulateTokenization(session.customClientId, `${SIM.OK}_race`);

    const results = await Promise.all([
      verifyTokenizationSession(session.id),
      verifyTokenizationSession(session.id),
      verifyTokenizationSession(session.id),
    ]);
    expect(results.every((r) => r.verified)).toBe(true);
    const ids = new Set(results.map((r) => (r.verified ? r.paymentMethodId : "")));
    expect(ids.size).toBe(1);

    const profile = await prisma.billingProfile.findFirst({
      where: { entity: { tenants: { some: { tenantId: tenant.id } } } },
    });
    expect(await prisma.paymentMethod.count({ where: { billingProfileId: profile!.id } })).toBe(1);
  });
});

describe("when the charge goes wrong", () => {
  async function chargeWith(prefix: (typeof SIM)[keyof typeof SIM]) {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { paymentMethodId } = await tokenize(tenant.id, checkout.id, prefix);
    const res = await executeCharge({
      attemptKey: `checkout:${checkout.reference}`,
      purpose: "SUBSCRIPTION_INITIAL",
      tenantId: tenant.id,
      checkoutId: checkout.id,
      commercialAmount: 499,
      commercialCurrency: "USD",
      description: "AI Workforce",
      paymentMethodId,
      providerCustomerId: "cli_e2e",
    });
    return { res, tenant, checkout };
  }

  it("a decline is FAILED, and may be retried", async () => {
    const { res, tenant } = await chargeWith(SIM.DECLINE);
    expect(res.state).toBe("FAILED");
    expect(chargeableAgain(res.state)).toBe(true);
    // Nothing was provisioned on a decline.
    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("PENDING_PAYMENT");
  });

  it("a timeout after submission is UNKNOWN, and must NOT be retried", async () => {
    const { res, checkout } = await chargeWith(SIM.TIMEOUT);
    expect(res.state).toBe("UNKNOWN");
    // The single most important assertion in this file: the charge may have
    // gone through, so retrying would take the money twice.
    expect(chargeableAgain(res.state)).toBe(false);

    const attempt = await prisma.paymentAttempt.findFirst({ where: { checkoutId: checkout.id } });
    // The row still records what was going to be submitted, so reconciliation
    // knows what to look for.
    expect(new Prisma.Decimal(attempt!.chargeAmount!).toFixed(2)).toBe("1821.35");
    expect(attempt!.providerRequestStartedAt).toBeTruthy();
  });

  it("an UNKNOWN cannot activate anything", async () => {
    const { res, checkout } = await chargeWith(SIM.TIMEOUT);
    await expect(
      activatePaidCheckout({ checkoutId: checkout.id, paymentAttemptId: res.attemptId }),
    ).rejects.toThrow(/attempt_not_succeeded/);
  });

  it("a success with no usable reference needs reconciliation, not a retry", async () => {
    const { res } = await chargeWith(SIM.NO_REF);
    // The charge landed but nothing came back to reconcile or refund it with.
    expect(res.state).toBe("RECONCILIATION_REQUIRED");
    expect(chargeableAgain(res.state)).toBe(false);
  });

  it("an expired card is a plain failure", async () => {
    const { res } = await chargeWith(SIM.EXPIRED_CARD);
    expect(res.state).toBe("FAILED");
    expect(res.failureCode ?? "").toMatch(/expired/i);
  });

  it("refuses to charge at all when no rate is approved", async () => {
    const { tenant, checkout } = await newTenantWithCheckout();
    const { paymentMethodId } = await tokenize(tenant.id, checkout.id);
    await prisma.billingExchangeRate.updateMany({
      where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
      data: { status: "RETIRED" },
    });
    try {
      await expect(
        executeCharge({
          attemptKey: `checkout:${checkout.reference}`,
          purpose: "SUBSCRIPTION_INITIAL",
          tenantId: tenant.id,
          checkoutId: checkout.id,
          commercialAmount: 499,
          commercialCurrency: "USD",
          description: "AI Workforce",
          paymentMethodId,
          providerCustomerId: "cli_e2e",
        }),
      ).rejects.toThrow(/no_active_rate/);
      // Fails closed: no attempt row, so nothing to reconcile later either.
      expect(await prisma.paymentAttempt.count({ where: { checkoutId: checkout.id } })).toBe(0);
    } finally {
      await seedApprovedRate();
    }
  });
});

describe("the simulator cannot touch anything real", () => {
  it("makes no network call and needs no credentials", async () => {
    delete process.env.ICOUNT_API_TOKEN;
    const { tenant, checkout } = await newTenantWithCheckout();
    // Would throw if a request were attempted without a token.
    const { paymentMethodId } = await tokenize(tenant.id, checkout.id);
    expect(paymentMethodId).toBeTruthy();
  });

  it("degrades to mock unless the simulator is explicitly acknowledged", async () => {
    delete process.env.ICOUNT_ALLOW_SIMULATOR;
    const { icountMode } = await import("../providers/icount-config");
    // A mode nobody asked for should not switch itself on.
    expect(icountMode()).toBe("mock");
  });

  it("holds the simulator to the same currency rule as production", async () => {
    const { simulateBill } = await import("../providers/icount-simulator");
    // A permissive simulator certifies code that would fail on the real thing.
    expect(() =>
      simulateBill({ sum: "100.00", token: `${SIM.OK}_x`, currencyId: 2, clientId: "c" }),
    ).toThrow(/only ILS charges are enabled/);
  });
});
