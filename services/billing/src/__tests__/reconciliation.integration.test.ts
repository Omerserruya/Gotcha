/**
 * Resolving charges whose outcome was never learned.
 *
 * The property under test: reconciliation ASKS, and when it cannot tell, it
 * says so. The ambiguity it faces is between "this customer paid" and "this
 * customer did not", and being wrong in either direction harms a real person -
 * so guessing is worse than escalating.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";

process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY =
  process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 5).toString("base64");

import { encryptPaymentToken } from "@chatcenter/shared";
import {
  sweepUnknownAttempts,
  pendingReconciliations,
  RECONCILE_AFTER_MS,
  MAX_PER_SWEEP,
} from "../services/reconciliation.service";
import { reconcileUnknown } from "../services/payment-attempt.service";
import type { PaymentProvider } from "../providers/provider";

const RUN = `rec-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const attemptIds: string[] = [];
const ORIGINAL = { ...process.env };

async function tenantWithCard() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId: tenant.id } });
  tenantIds.push(tenant.id);
  entityIds.push(entity.id);
  const profile = await prisma.billingProfile.create({
    data: { billableEntityId: entity.id, provider: "ICOUNT", providerCustomerId: "cli_rec" },
  });
  const sealed = encryptPaymentToken(`tok_${n}`);
  await prisma.paymentMethod.create({
    data: {
      billingProfileId: profile.id, provider: "ICOUNT",
      token: sealed.ciphertext, tokenKeyVersion: sealed.keyVersion,
      brand: "visa", last4: "4242", isDefault: true, status: "ACTIVE",
    },
  });
  return tenant;
}

/** An attempt stuck in an unresolved state, old enough for the sweep to touch. */
async function stuckAttempt(opts: { state?: any; chargeAmount?: string | null; ageMs?: number } = {}) {
  const tenant = await tenantWithCard();
  const attempt = await prisma.paymentAttempt.create({
    data: {
      attemptKey: `${RUN}-${Math.random().toString(36).slice(2, 10)}`,
      tenantId: tenant.id,
      purpose: "SUBSCRIPTION_INITIAL",
      amount: 499,
      currency: "USD",
      chargeAmount: opts.chargeAmount === null ? null : (opts.chargeAmount ?? "1821.35"),
      chargeCurrency: opts.chargeAmount === null ? null : "ILS",
      providerCurrencyId: opts.chargeAmount === null ? null : 1,
      state: opts.state ?? "UNKNOWN",
      providerRequestStartedAt: new Date(),
    },
  });
  attemptIds.push(attempt.id);
  // Nudge updatedAt into the past so the sweep considers it.
  const age = opts.ageMs ?? RECONCILE_AFTER_MS + 60_000;
  await prisma.$executeRawUnsafe(
    `UPDATE payment_attempts SET updated_at = NOW() - INTERVAL '${Math.round(age / 1000)} seconds' WHERE id = $1`,
    attempt.id,
  );
  return { tenant, attempt };
}

/** A provider whose transaction list the test controls. */
function providerReturning(transactions: Array<Record<string, unknown>>): PaymentProvider {
  return {
    name: "ICOUNT",
    async tokenizeAndVerify() { throw new Error("not used"); },
    async charge() { throw new Error("reconciliation must never charge"); },
    async refund() { throw new Error("not used"); },
    async lookupTransactions() { return { transactions }; },
    verifyWebhook() { return false; },
  };
}

beforeEach(() => {
  process.env.ICOUNT_MODE = "simulator";
  process.env.ICOUNT_ALLOW_SIMULATOR = "true";
  delete process.env.ICOUNT_ALLOW_LIVE;
});

afterAll(async () => {
  await prisma.paymentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
  const profiles = await prisma.billingProfile.findMany({
    where: { billableEntityId: { in: entityIds } }, select: { id: true },
  });
  await prisma.paymentMethod.deleteMany({ where: { billingProfileId: { in: profiles.map((p) => p.id) } } });
  await prisma.billingProfile.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  process.env = { ...ORIGINAL };
});

describe("an unknown charge is settled by asking, never by guessing", () => {
  it("one matching transaction resolves it as paid", async () => {
    const { attempt } = await stuckAttempt();
    const res = await reconcileUnknown({
      attemptId: attempt.id,
      // Matched on the SHEKEL figure that was submitted. Matching the dollar
      // amount would find nothing, and every charge would look unpaid.
      provider: providerReturning([{ sum: 1821.35, confirmation_code: "conf_1" }]),
      token: "tok",
    });
    expect(res.state).toBe("SUCCEEDED");
    const after = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
    expect(after!.providerChargeRef).toBe("conf_1");
    expect(after!.reconciledAt).toBeTruthy();
  });

  it("no matching transaction resolves it as not paid", async () => {
    const { attempt } = await stuckAttempt();
    const res = await reconcileUnknown({
      attemptId: attempt.id,
      provider: providerReturning([{ sum: 99.0 }]),
      token: "tok",
    });
    // Safe to charge again: the provider has no record of this one.
    expect(res.state).toBe("FAILED");
  });

  it("two identical candidates go to a human rather than picking one", async () => {
    const { attempt } = await stuckAttempt();
    const res = await reconcileUnknown({
      attemptId: attempt.id,
      provider: providerReturning([
        { sum: 1821.35, confirmation_code: "a" },
        { sum: 1821.35, confirmation_code: "b" },
      ]),
      token: "tok",
    });
    // Without a merchant reference, these are genuinely indistinguishable.
    expect(res.state).toBe("MANUAL_REVIEW");
    expect(res.candidates).toBe(2);
  });

  it("escalates when the attempt records no submitted amount to match on", async () => {
    const { attempt } = await stuckAttempt({ chargeAmount: null });
    const res = await reconcileUnknown({
      attemptId: attempt.id,
      provider: providerReturning([{ sum: 1821.35 }]),
      token: "tok",
    });
    // Comparing against the commercial figure would be comparing dollars to
    // shekels and calling the mismatch evidence.
    expect(res.state).toBe("MANUAL_REVIEW");
  });

  it("escalates when the provider cannot be asked at all", async () => {
    const { attempt } = await stuckAttempt();
    const blind = { ...providerReturning([]), lookupTransactions: undefined } as any;
    const res = await reconcileUnknown({ attemptId: attempt.id, provider: blind });
    expect(res.state).toBe("MANUAL_REVIEW");
  });

  it("leaves an already-settled attempt alone", async () => {
    const { attempt } = await stuckAttempt({ state: "SUCCEEDED" });
    const res = await reconcileUnknown({
      attemptId: attempt.id,
      provider: providerReturning([{ sum: 1821.35 }]),
      token: "tok",
    });
    expect(res.state).toBe("SUCCEEDED");
  });
});

describe("the sweep", () => {
  it("waits before asking about a charge just submitted", async () => {
    const { attempt } = await stuckAttempt({ ageMs: 0 });
    await sweepUnknownAttempts();
    const after = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
    // Asking too early gets a confident "no transaction" for one that is about
    // to appear, which would mark a paying customer unpaid.
    expect(after!.state).toBe("UNKNOWN");
    expect(after!.reconciledAt).toBeNull();
  });

  it("is bounded, so one bad run cannot hammer the provider", () => {
    expect(MAX_PER_SWEEP).toBeGreaterThan(0);
    expect(MAX_PER_SWEEP).toBeLessThanOrEqual(50);
  });

  it("never re-submits a charge", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const svc = readFileSync(join(__dirname, "../services/reconciliation.service.ts"), "utf8");
    const code = svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of ["executeCharge", "runAttempt", "chargeFor", ".charge("]) {
      expect(code, `reconciliation must not ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("lists what a human needs, and no card token", async () => {
    await stuckAttempt({ state: "MANUAL_REVIEW" });
    const rows = await pendingReconciliations();
    expect(rows.length).toBeGreaterThan(0);
    const json = JSON.stringify(rows);
    // Enough to identify the customer and the money; nothing that could charge
    // them again.
    expect(rows[0]).toHaveProperty("organizationName");
    expect(rows[0]).toHaveProperty("chargeAmount");
    for (const secret of ["token", "attemptKey", "providerChargeRef"]) {
      expect(json, `must not expose ${secret}`).not.toContain(`"${secret}"`);
    }
  });
});
