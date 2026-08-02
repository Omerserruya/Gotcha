import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Auto-purchase is the money-moving path that runs without a human present, so
 * these tests are about what it must REFUSE to do.
 *
 * The prisma mock models the two things that make the safety properties real:
 *   • `autoPurchasePolicy.updateMany` behaves like a genuine compare-and-set -
 *     it only matches when the WHERE clause holds, so exactly one of two
 *     concurrent callers can claim the lock;
 *   • `chargeFor` records every call, so "did it charge twice?" is answerable.
 */

const db = {
  policy: null as any,
  subscription: null as any,
  plan: null as any,
  profile: null as any,
  package: null as any,
  balance: { includedRemaining: 0, purchasedRemaining: 0, includedAllowance: 2000, total: 0, periodKey: "2026-08" },
};

const charges: Array<{ amount: number; idempotencyKey: string }> = [];
const grants: Array<{ units: number; source?: string }> = [];
const events: Array<{ type: string; data: any }> = [];
let chargeSucceeds = true;

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    autoPurchasePolicy: {
      findUnique: async () => db.policy,
      // The CAS: matches only when the lock predicate holds.
      updateMany: async ({ where, data }: any) => {
        if (!db.policy) return { count: 0 };
        if (where.lockToken !== undefined) {
          if (db.policy.lockToken !== where.lockToken) return { count: 0 };
          Object.assign(db.policy, data);
          return { count: 1 };
        }
        const free = db.policy.lockedAt == null;
        const stale = db.policy.lockedAt != null && where.OR?.[1]?.lockedAt?.lt && db.policy.lockedAt < where.OR[1].lockedAt.lt;
        if (!free && !stale) return { count: 0 };
        Object.assign(db.policy, data);
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        Object.assign(db.policy, data);
        return db.policy;
      },
    },
    subscription: { findUnique: async () => db.subscription },
    plan: { findUnique: async () => db.plan },
    billingProfile: { findUnique: async () => db.profile },
    creditPackage: { findUnique: async () => db.package },
  },
  grantUnits: async (input: any) => {
    grants.push({ units: input.units, source: input.source });
    return { lotId: "lot-1" };
  },
  getBalance: async () => db.balance,
}));

vi.mock("../services/billable-entity.service", () => ({
  getEntityIdForTenant: async () => "entity-1",
}));

vi.mock("../services/invoice.service", () => ({
  chargeFor: async (input: any) => {
    charges.push({ amount: input.amount, idempotencyKey: input.idempotencyKey });
    return chargeSucceeds
      ? { success: true, invoiceId: `inv-${charges.length}` }
      : { success: false, invoiceId: `inv-${charges.length}`, failureCode: "card_declined" };
  },
}));

vi.mock("../lib/events", () => ({
  emitBillingEvent: async (e: any) => {
    events.push(e);
  },
}));

import { triggerAutoPurchase, packageAvailable, effectivePackagePrice, packageExpiry } from "../services/purchase.service";
import { periodKeyFor } from "../lib/period";

const TENANT = "tenant-1";

function reset() {
  charges.length = 0;
  grants.length = 0;
  events.length = 0;
  chargeSucceeds = true;
  db.policy = {
    billableEntityId: "entity-1",
    enabled: true,
    thresholdPct: 10,
    packageKey: "credits_5000",
    maxMonthlySpend: 500,
    currency: "USD",
    monthSpendKey: null,
    monthSpentAmount: 0,
    incrementCredits: null,
    pricePerCredit: null,
    limitBehavior: "STOP_AI",
    lockedAt: null,
    lockToken: null,
  };
  db.subscription = { planKey: "ai_workforce", planVersion: 1, status: "ACTIVE", currentPeriodEnd: new Date("2026-09-01") };
  db.plan = { autoPurchaseEligible: true, creditPackagesEligible: true, includedAiUnits: 2000 };
  db.profile = { id: "bp-1", paymentMethods: [{ id: "pm-1" }] };
  db.package = {
    key: "credits_5000", name: "5,000 credits", units: 5000, price: 110, currency: "USD",
    active: true, status: "ACTIVE", activeFrom: null, activeTo: null, eligiblePlanKeys: null,
    scheduledPrice: null, scheduledPriceFrom: null, expiryPolicy: "NEVER", expiryDays: null,
    maxPurchaseQuantity: null,
  };
  // Below the 10% threshold of a 2,000 allowance → a genuine shortage.
  db.balance = { includedRemaining: 100, purchasedRemaining: 0, includedAllowance: 2000, total: 100, periodKey: "2026-08" };
}

beforeEach(reset);

describe("auto-purchase — refuses when it should", () => {
  it("does nothing when the policy is disabled", async () => {
    db.policy.enabled = false;
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r).toMatchObject({ success: false, failureCode: "auto_purchase_disabled" });
    expect(charges).toHaveLength(0);
  });

  it("does nothing when the customer chose prepaid-only", async () => {
    db.policy.limitBehavior = "PREPAID_ONLY";
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("prepaid_only");
    expect(charges).toHaveLength(0);
  });

  it("refuses when the plan does not allow auto-purchase", async () => {
    db.plan.autoPurchaseEligible = false;
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("plan_not_eligible_for_auto_purchase");
    expect(charges).toHaveLength(0);
  });

  it("refuses without a payment method rather than failing at the provider", async () => {
    db.profile = { id: "bp-1", paymentMethods: [] };
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("no_payment_method");
    expect(charges).toHaveLength(0);
    expect(events.some((e) => e.type === "credit.auto_purchase_failed")).toBe(true);
  });

  it("refuses on a cancelled subscription", async () => {
    db.subscription.status = "CANCELED";
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("subscription_canceled");
    expect(charges).toHaveLength(0);
  });

  /**
   * The regression that matters: a threshold notification arriving after the
   * customer already topped up manually must not trigger a second charge.
   */
  it("refuses when there is no actual shortage", async () => {
    db.balance = { includedRemaining: 1800, purchasedRemaining: 0, includedAllowance: 2000, total: 1800, periodKey: "2026-08" };
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("no_shortage");
    expect(charges).toHaveLength(0);
  });

  it("refuses when the top-up would cross the monthly ceiling", async () => {
    db.policy.monthSpendKey = periodKeyFor(new Date());
    db.policy.monthSpentAmount = 450; // + 110 > 500
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("monthly_ceiling_reached");
    expect(charges).toHaveLength(0);
    const evt = events.find((e) => e.type === "credit.auto_purchase_ceiling_reached");
    expect(evt?.data).toMatchObject({ ceiling: 500, spentThisMonth: 450 });
    // The customer is pointed at a manual path rather than silently stopped.
    expect(evt?.data.manualPurchasePath).toBe("/settings/billing/credits");
  });

  it("grants nothing when the provider declines", async () => {
    chargeSucceeds = false;
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.success).toBe(false);
    expect(charges).toHaveLength(1);
    expect(grants).toHaveLength(0); // credits only ever follow a confirmed charge
  });
});

describe("auto-purchase — succeeds correctly", () => {
  it("charges once and grants the package's credits", async () => {
    const r = await triggerAutoPurchase({ tenantId: TENANT, reason: "usage_threshold" });
    expect(r).toMatchObject({ success: true, units: 5000 });
    expect(charges).toHaveLength(1);
    expect(charges[0].amount).toBe(110);
    expect(grants).toEqual([{ units: 5000, source: "auto:credits_5000" }]);
    expect(events.some((e) => e.type === "credit.auto_purchase_succeeded")).toBe(true);
  });

  it("records the spend against the current month", async () => {
    await triggerAutoPurchase({ tenantId: TENANT });
    expect(Number(db.policy.monthSpentAmount)).toBe(110);
    expect(db.policy.lastTriggeredAt).toBeTruthy();
  });

  it("releases the lock afterwards, so the next top-up is not blocked", async () => {
    await triggerAutoPurchase({ tenantId: TENANT });
    expect(db.policy.lockedAt).toBeNull();
    expect(db.policy.lockToken).toBeNull();
  });

  it("prefers an increment + price-per-credit policy over a fixed package", async () => {
    db.policy.incrementCredits = 1000;
    db.policy.pricePerCredit = 0.03;
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r).toMatchObject({ success: true, units: 1000 });
    expect(charges[0].amount).toBe(30); // 1000 x $0.03
    expect(grants[0].source).toBe("auto:increment");
  });

  it("refuses when neither a package nor an increment is configured", async () => {
    db.policy.packageKey = null;
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("no_top_up_configured");
    expect(charges).toHaveLength(0);
  });
});

describe("auto-purchase — concurrency", () => {
  /**
   * Before the lock, two concurrent threshold crossings could both read the same
   * monthSpentAmount, both pass the ceiling check, and both charge - overshooting
   * the customer's configured limit.
   */
  it("two concurrent triggers result in exactly one charge", async () => {
    const [a, b] = await Promise.all([
      triggerAutoPurchase({ tenantId: TENANT }),
      triggerAutoPurchase({ tenantId: TENANT }),
    ]);
    const succeeded = [a, b].filter((r) => r.success);
    const blocked = [a, b].filter((r) => r.failureCode === "purchase_in_progress");
    expect(succeeded).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(charges).toHaveLength(1);
    expect(grants).toHaveLength(1);
  });

  it("five concurrent triggers still result in exactly one charge", async () => {
    const results = await Promise.all(
      new Array(5).fill(0).map(() => triggerAutoPurchase({ tenantId: TENANT })),
    );
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(charges).toHaveLength(1);
    expect(Number(db.policy.monthSpentAmount)).toBe(110);
  });

  it("does not overshoot the ceiling under concurrency", async () => {
    db.policy.maxMonthlySpend = 150; // room for exactly one $110 top-up
    await Promise.all(new Array(4).fill(0).map(() => triggerAutoPurchase({ tenantId: TENANT })));
    const spent = charges.reduce((s, c) => s + c.amount, 0);
    expect(spent).toBeLessThanOrEqual(150);
  });

  /** A crashed worker must not wedge auto-purchase forever. */
  it("reclaims a stale lock", async () => {
    db.policy.lockedAt = new Date(Date.now() - 5 * 60_000);
    db.policy.lockToken = "dead-worker";
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.success).toBe(true);
    expect(charges).toHaveLength(1);
  });

  it("respects a lock that is still fresh", async () => {
    db.policy.lockedAt = new Date();
    db.policy.lockToken = "other-worker";
    const r = await triggerAutoPurchase({ tenantId: TENANT });
    expect(r.failureCode).toBe("purchase_in_progress");
    expect(charges).toHaveLength(0);
  });
});

describe("credit package availability", () => {
  const base = { active: true, status: "ACTIVE", activeFrom: null, activeTo: null, eligiblePlanKeys: null };
  const NOW = new Date("2026-08-01T00:00:00Z");

  it("accepts an unrestricted active package", () => {
    expect(packageAvailable(base, "foundation", NOW).ok).toBe(true);
  });

  it("rejects an inactive package", () => {
    expect(packageAvailable({ ...base, active: false }, "foundation", NOW)).toMatchObject({ ok: false, reason: "package_inactive" });
  });

  it("rejects outside its active window", () => {
    expect(packageAvailable({ ...base, activeFrom: new Date("2026-09-01") }, "foundation", NOW).reason).toBe("package_not_yet_active");
    expect(packageAvailable({ ...base, activeTo: new Date("2026-07-01") }, "foundation", NOW).reason).toBe("package_expired");
  });

  it("enforces plan eligibility", () => {
    const restricted = { ...base, eligiblePlanKeys: ["ai_voice"] };
    expect(packageAvailable(restricted, "ai_voice", NOW).ok).toBe(true);
    expect(packageAvailable(restricted, "foundation", NOW).reason).toBe("package_not_eligible_for_plan");
    expect(packageAvailable(restricted, null, NOW).reason).toBe("package_not_eligible_for_plan");
  });

  it("uses a scheduled price only once its date has arrived", () => {
    const pkg = { price: 110, scheduledPrice: 130, scheduledPriceFrom: new Date("2026-09-01") };
    expect(effectivePackagePrice(pkg, NOW)).toBe(110);
    expect(effectivePackagePrice(pkg, new Date("2026-09-02"))).toBe(130);
  });

  it("applies the package expiry policy", () => {
    const periodEnd = new Date("2026-09-01");
    expect(packageExpiry({ expiryPolicy: "NEVER", expiryDays: null }, periodEnd, NOW)).toBeNull();
    expect(packageExpiry({ expiryPolicy: "PERIOD_END", expiryDays: null }, periodEnd, NOW)).toBe(periodEnd);
    const days = packageExpiry({ expiryPolicy: "DAYS_AFTER_PURCHASE", expiryDays: 30 }, periodEnd, NOW);
    expect(days?.toISOString().slice(0, 10)).toBe("2026-08-31");
  });
});
