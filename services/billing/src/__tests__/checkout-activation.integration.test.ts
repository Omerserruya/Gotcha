/**
 * The paid-checkout activation boundary.
 *
 * DB-backed, because the duplicate-activation guarantee is a conditional UPDATE
 * and only the real database can prove it holds under concurrency.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  activatePaidCheckout,
  assertActivatable,
  ActivationRefused,
} from "../services/checkout-activation.service";
import type { PaymentAttemptState } from "@prisma/client";

const RUN = `act-${Date.now()}`;
const tenantIds: string[] = [];
const checkoutIds: string[] = [];
const attemptIds: string[] = [];
const quoteIds: string[] = [];

async function fixture(opts: {
  amount?: number;
  currency?: string;
  attemptState?: PaymentAttemptState;
  consumed?: boolean;
  checkoutStatus?: "PENDING" | "EXPIRED" | "CANCELED" | "PAID";
  withoutQuote?: boolean;
} = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({
    data: { name: n, slug: n, status: "PENDING_PAYMENT" },
  });
  tenantIds.push(tenant.id);

  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({
    data: { billableEntityId: entity.id, tenantId: tenant.id },
  });

  const amount = opts.amount ?? 499;
  const currency = opts.currency ?? "ILS";

  const checkout = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${n}`,
      tenantId: tenant.id,
      planKey: "ai_workforce",
      planVersion: 1,
      snapshotPrice: 499,
      snapshotCurrency: "ILS",
      snapshotIncludedCredits: 2000,
      amount: 499,
      currency: "ILS",
      status: opts.checkoutStatus ?? "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: `checkout:chk_${n}`,
    },
  });
  checkoutIds.push(checkout.id);

  // This plan is priced in ILS and charged in ILS, so the quote is an identity
  // one: no conversion, no approved rate to pin. It still has to exist, because
  // a provider payment with no quote is a charge nobody can reconcile.
  const quote = opts.withoutQuote
    ? null
    : await prisma.paymentQuote.create({
        data: {
          tenantId: tenant.id,
          checkoutId: checkout.id,
          purpose: "SUBSCRIPTION_INITIAL",
          commercialAmount: 499,
          commercialCurrency: "ILS",
          fxRateId: null,
          fxRate: 1,
          fxRateSource: "IDENTITY",
          fxRateVersion: 0,
          fxQuotedAt: new Date(),
          chargeAmount: 499,
          chargeCurrency: "ILS",
          providerCurrencyId: 5,
          expiresAt: new Date(Date.now() + 3_600_000),
          status: "ACTIVE",
        },
      });
  if (quote) quoteIds.push(quote.id);

  const attempt = await prisma.paymentAttempt.create({
    data: {
      attemptKey: `${n}:initial`,
      checkoutId: checkout.id,
      tenantId: tenant.id,
      purpose: "SUBSCRIPTION_INITIAL",
      amount,
      currency,
      state: opts.attemptState ?? "SUCCEEDED",
      consumedByActivationAt: opts.consumed ? new Date() : null,
      paymentQuoteId: quote?.id ?? null,
      chargeAmount: quote ? 499 : null,
      chargeCurrency: quote ? "ILS" : null,
      providerCurrencyId: quote ? 5 : null,
    },
  });
  attemptIds.push(attempt.id);

  return { tenant, checkout, attempt, quote, entityId: entity.id };
}

afterAll(async () => {
  await prisma.paymentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
  await prisma.paymentQuote.deleteMany({ where: { id: { in: quoteIds } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: checkoutIds } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => {});
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("a confirmed attempt activates exactly once", () => {
  it("43. SUCCEEDED activates, tenant moves to onboarding, checkout PAID", async () => {
    const { tenant, checkout, attempt } = await fixture();

    const res = await activatePaidCheckout({ checkoutId: checkout.id, paymentAttemptId: attempt.id });
    expect(res.firstActivation).toBe(true);

    const [t, c, sub] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenant.id } }),
      prisma.pendingCheckout.findUnique({ where: { id: checkout.id } }),
      prisma.subscription.findFirst({ where: { planKey: "ai_workforce" }, orderBy: { createdAt: "desc" } }),
    ]);
    // Money settled, setup did not. The subscription is live and the checkout
    // is PAID, but a tenant that has never onboarded goes to the wizard rather
    // than into a product it has not been configured for.
    expect(t?.status).toBe("PENDING_ONBOARDING");
    expect(c?.status).toBe("PAID");
    expect(sub?.status).toBe("ACTIVE");
  });

  it("50. concurrent activation grants credits once", async () => {
    const { tenant, checkout, attempt } = await fixture();

    // Five callers race. The conditional consume means one wins.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        activatePaidCheckout({ checkoutId: checkout.id, paymentAttemptId: attempt.id }).catch(
          (e) => ({ firstActivation: false, error: e.message }) as any,
        ),
      ),
    );
    expect(results.filter((r: any) => r.firstActivation === true)).toHaveLength(1);

    const lots = await prisma.aiUnitLot.findMany({ where: { tenantId: tenant.id } });
    const granted = lots.reduce((sum, l) => sum + Number(l.unitsGranted ?? 0), 0);
    expect(granted).toBe(2000); // exactly one grant, not five
  });

  it("52-53. the snapshot is preserved and renewal stays with GOTCHA", async () => {
    const { checkout, attempt, entityId } = await fixture();
    await activatePaidCheckout({ checkoutId: checkout.id, paymentAttemptId: attempt.id });

    const sub = await prisma.subscription.findUnique({ where: { billableEntityId: entityId } });
    expect(Number(sub?.snapshotPrice)).toBe(499);
    expect(sub?.snapshotCurrency).toBe("ILS");
    expect(sub?.snapshotIncludedCredits).toBe(2000);
    // No iCount standing order exists anywhere; GOTCHA's own sweep renews this.
    expect(sub?.cancelAtPeriodEnd).toBe(false);
    expect(sub?.currentPeriodEnd).toBeTruthy();
  });
});

describe("activation refuses everything that is not confirmed payment", () => {
  const refuse = async (opts: Parameters<typeof fixture>[0], code: RegExp) => {
    const { checkout, attempt } = await fixture(opts);
    await expect(
      activatePaidCheckout({ checkoutId: checkout.id, paymentAttemptId: attempt.id }),
    ).rejects.toThrow(code);
  };

  it("44. a PENDING attempt cannot activate", () => refuse({ attemptState: "PENDING" }, /attempt_not_succeeded/));

  it("45. an UNKNOWN attempt cannot activate", () =>
    // "we might have been paid" is not payment.
    refuse({ attemptState: "UNKNOWN" }, /attempt_not_succeeded/));

  it("45b. RECONCILIATION_REQUIRED cannot activate", () =>
    refuse({ attemptState: "RECONCILIATION_REQUIRED" }, /attempt_not_succeeded/));

  it("46. MANUAL_REVIEW cannot activate", () =>
    refuse({ attemptState: "MANUAL_REVIEW" }, /attempt_not_succeeded/));

  it("46b. a FAILED attempt cannot activate", () => refuse({ attemptState: "FAILED" }, /attempt_not_succeeded/));

  it("47. an amount mismatch blocks activation", () => refuse({ amount: 498 }, /amount_mismatch/));

  it("48. a currency mismatch blocks activation", () => refuse({ currency: "USD" }, /currency_mismatch/));

  it("46c. an already-consumed attempt cannot activate again", () =>
    refuse({ consumed: true }, /attempt_already_consumed/));

  it("an expired or cancelled checkout cannot activate", async () => {
    await refuse({ checkoutStatus: "EXPIRED" }, /checkout_expired/);
    await refuse({ checkoutStatus: "CANCELED" }, /checkout_canceled/);
  });

  it("49. an attempt from another checkout blocks activation", async () => {
    const a = await fixture();
    const b = await fixture();
    // b's attempt does not belong to a's checkout.
    expect(() => assertActivatable(a.checkout as any, b.attempt as any)).toThrow(
      /attempt_not_for_this_checkout/,
    );
  });

  it("49b. a tenant mismatch blocks activation", async () => {
    const a = await fixture();
    const foreign = { ...a.attempt, tenantId: "some-other-tenant" };
    expect(() => assertActivatable(a.checkout as any, foreign as any)).toThrow(/tenant_mismatch/);
  });

  it("refusals are typed, so callers cannot mistake them for success", async () => {
    const { checkout, attempt } = await fixture({ attemptState: "UNKNOWN" });
    await expect(
      activatePaidCheckout({ checkoutId: checkout.id, paymentAttemptId: attempt.id }),
    ).rejects.toBeInstanceOf(ActivationRefused);
  });
});

describe("no browser-callable completion path exists", () => {
  it("activation is not exposed by any route", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "../routes");
    // Files only: src/routes gained a subdirectory, and readFileSync on a
    // directory throws EISDIR.
    const hits = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .filter((e) => /activatePaidCheckout/.test(readFileSync(join(dir, e.name), "utf8")))
      .map((e) => e.name);
    expect(hits, `activation must not be reachable from a route: ${hits.join(", ")}`).toEqual([]);
  });
});
