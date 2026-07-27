/**
 * What checkout cleanup deletes, and what it must never touch.
 *
 * The second half matters more than the first. A consumed payment quote is the
 * only record of what a customer was charged and at what rate; deleting one
 * would make a real charge unexplainable months later, when explaining it is
 * exactly what someone needs to do.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  purgeSpentCheckoutArtifacts,
  SESSION_RETENTION_DAYS,
  LINK_RETENTION_DAYS,
  UNUSED_QUOTE_RETENTION_DAYS,
} from "../services/billing-retention.service";
import { proposeRate, approveRate } from "../services/exchange-rate.service";

const RUN = `ret-${Date.now()}`;
const tenantIds: string[] = [];
const checkoutIds: string[] = [];
const rateIds: string[] = [];
let rateId = "";

const DAY = 24 * 60 * 60 * 1000;
const old = (days: number) => new Date(Date.now() - (days + 5) * DAY);
const recent = () => new Date();

async function tenantWithCheckout() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  tenantIds.push(tenant.id);
  const checkout = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${n}`, tenantId: tenant.id,
      planKey: "ai_workforce", planVersion: 1,
      snapshotPrice: 499, snapshotCurrency: "USD", snapshotIncludedCredits: 2000,
      amount: 499, currency: "USD", status: "PENDING",
      expiresAt: new Date(Date.now() + DAY),
      idempotencyKey: `checkout:chk_${n}`,
    },
  });
  checkoutIds.push(checkout.id);
  return { tenant, checkout };
}

/** Backdate a row past its retention window; Prisma manages updatedAt itself. */
async function backdate(table: string, id: string, column: string, when: Date) {
  await prisma.$executeRawUnsafe(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, when, id);
}

async function makeQuote(checkoutId: string, tenantId: string, status: any, consumedByAttemptId: string | null) {
  return prisma.paymentQuote.create({
    data: {
      tenantId, checkoutId,
      purpose: "SUBSCRIPTION_INITIAL",
      commercialAmount: 499, commercialCurrency: "USD",
      fxRateId: rateId, fxRate: "3.65", fxRateSource: "MANUAL_PLATFORM_RATE", fxRateVersion: 1,
      fxQuotedAt: new Date(),
      chargeAmount: "1821.35", chargeCurrency: "ILS", providerCurrencyId: 1,
      expiresAt: new Date(Date.now() - DAY),
      status,
      consumedByAttemptId,
      consumedAt: consumedByAttemptId ? new Date() : null,
    },
  });
}

beforeAll(async () => {
  const draft = await proposeRate({ rate: "3.65", reason: "test seed", createdBy: `${RUN}-a` });
  rateIds.push(draft.id);
  const active = await approveRate({ id: draft.id, approvedBy: `${RUN}-b` });
  rateId = active.id;
});

afterAll(async () => {
  await prisma.paymentQuote.deleteMany({ where: { checkoutId: { in: checkoutIds } } });
  await prisma.paymentContinuationLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tokenizationSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: checkoutIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.billingExchangeRate.deleteMany({ where: { id: { in: rateIds } } });
});

describe("finished artifacts are cleaned up", () => {
  it("deletes an old abandoned tokenization session", async () => {
    const { tenant, checkout } = await tenantWithCheckout();
    const session = await prisma.tokenizationSession.create({
      data: {
        tenantId: tenant.id, checkoutId: checkout.id,
        customClientId: `gtok_${RUN}_${Math.random().toString(36).slice(2, 10)}`,
        pageId: "1", status: "ABANDONED",
        baselineFingerprints: ["deadbeef"],
        expiresAt: new Date(Date.now() - DAY),
      },
    });
    await backdate("tokenization_sessions", session.id, "updated_at", old(SESSION_RETENTION_DAYS));

    await purgeSpentCheckoutArtifacts();
    expect(await prisma.tokenizationSession.findUnique({ where: { id: session.id } })).toBeNull();
  });

  it("keeps a session someone may still be finishing", async () => {
    const { tenant, checkout } = await tenantWithCheckout();
    const session = await prisma.tokenizationSession.create({
      data: {
        tenantId: tenant.id, checkoutId: checkout.id,
        customClientId: `gtok_${RUN}_${Math.random().toString(36).slice(2, 10)}`,
        pageId: "1", status: "AWAITING_RETURN",
        baselineFingerprints: [],
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    // Backdated, but NOT terminal. Age alone would delete the session of
    // someone who is simply slow on the hosted page, and losing their customer
    // reference strands them exactly as a lost session does.
    await backdate("tokenization_sessions", session.id, "updated_at", old(SESSION_RETENTION_DAYS));

    await purgeSpentCheckoutArtifacts();
    expect(await prisma.tokenizationSession.findUnique({ where: { id: session.id } })).not.toBeNull();
  });

  it("deletes an old revoked continuation link", async () => {
    const { tenant, checkout } = await tenantWithCheckout();
    const link = await prisma.paymentContinuationLink.create({
      data: {
        checkoutId: checkout.id, tenantId: tenant.id,
        tokenHash: `hash_${Math.random().toString(36).slice(2)}`,
        purpose: "PAID_TENANT_ONBOARDING",
        expiresAt: new Date(Date.now() - DAY),
        revokedAt: new Date(),
      },
    });
    await backdate("payment_continuation_links", link.id, "created_at", old(LINK_RETENTION_DAYS));

    await purgeSpentCheckoutArtifacts();
    expect(await prisma.paymentContinuationLink.findUnique({ where: { id: link.id } })).toBeNull();
  });

  it("keeps a link that still works", async () => {
    const { tenant, checkout } = await tenantWithCheckout();
    const link = await prisma.paymentContinuationLink.create({
      data: {
        checkoutId: checkout.id, tenantId: tenant.id,
        tokenHash: `hash_${Math.random().toString(36).slice(2)}`,
        purpose: "PAID_TENANT_ONBOARDING",
        expiresAt: new Date(Date.now() + 7 * DAY),
      },
    });
    await backdate("payment_continuation_links", link.id, "created_at", old(LINK_RETENTION_DAYS));
    await purgeSpentCheckoutArtifacts();
    // Old, but a customer could still be about to use it.
    expect(await prisma.paymentContinuationLink.findUnique({ where: { id: link.id } })).not.toBeNull();
  });
});

describe("nothing that records money moving is ever deleted", () => {
  it("keeps a consumed quote no matter how old", async () => {
    const { tenant, checkout } = await tenantWithCheckout();
    const attempt = await prisma.paymentAttempt.create({
      data: {
        attemptKey: `${RUN}-${Math.random().toString(36).slice(2, 10)}`,
        tenantId: tenant.id, checkoutId: checkout.id,
        purpose: "SUBSCRIPTION_INITIAL", amount: 499, currency: "USD",
        state: "SUCCEEDED",
      },
    });
    const quote = await makeQuote(checkout.id, tenant.id, "CONSUMED", attempt.id);
    await backdate("payment_quotes", quote.id, "created_at", old(UNUSED_QUOTE_RETENTION_DAYS * 100));

    await purgeSpentCheckoutArtifacts();

    // This row is the only record of what the customer was charged and at what
    // rate. Losing it makes a real charge unexplainable.
    const kept = await prisma.paymentQuote.findUnique({ where: { id: quote.id } });
    expect(kept).not.toBeNull();
    expect(String(kept!.chargeAmount)).toContain("1821.35");

    await prisma.paymentAttempt.delete({ where: { id: attempt.id } }).catch(() => {});
  });

  it("deletes a quote that was never charged against", async () => {
    const { tenant, checkout } = await tenantWithCheckout();
    const quote = await makeQuote(checkout.id, tenant.id, "EXPIRED", null);
    await backdate("payment_quotes", quote.id, "created_at", old(UNUSED_QUOTE_RETENTION_DAYS));

    await purgeSpentCheckoutArtifacts();
    // Records a conversion that never became a charge - nothing happened.
    expect(await prisma.paymentQuote.findUnique({ where: { id: quote.id } })).toBeNull();
  });

  it("touches no financial table at all", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const svc = readFileSync(join(__dirname, "../services/billing-retention.service.ts"), "utf8");
    const code = svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const table of ["charge.delete", "invoice.delete", "paymentAttempt.delete", "subscription.delete", "aiUnitLot.delete", "auditLog.delete"]) {
      expect(code, `retention must not ${table}`).not.toContain(table);
    }
  });

  it("is bounded per run", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const svc = readFileSync(join(__dirname, "../services/billing-retention.service.ts"), "utf8");
    // A first purge on a large table must not stall the scheduler tick.
    expect(svc).toContain("MAX_PER_RUN");
    expect(svc.match(/take: MAX_PER_RUN/g)?.length).toBe(3);
  });
});
