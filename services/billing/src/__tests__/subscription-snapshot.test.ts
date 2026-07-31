import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Plan versioning is only real if publishing a new version cannot change what an
 * existing customer pays. These tests exercise that directly: they publish a
 * price change on the LIVE plan row and assert the renewal still charges the
 * snapshot.
 */

const db = {
  subscription: null as any,
  plans: [] as any[],
  balance: { includedRemaining: 0, purchasedRemaining: 0, includedAllowance: 2000, total: 0, periodKey: "2026-08" },
};

const charges: Array<{ amount: number; currency: string; description: string }> = [];
const rollovers: Array<{ tenantId: string; allowance: number; source: string }> = [];
const subscriptionUpdates: any[] = [];
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
    subscription: {
      findUnique: async () => db.subscription,
      update: async ({ data }: any) => {
        subscriptionUpdates.push(data);
        Object.assign(db.subscription, data);
        return db.subscription;
      },
      upsert: async ({ create, update }: any) => {
        if (db.subscription) Object.assign(db.subscription, update);
        else db.subscription = { id: "sub-1", ...create };
        return db.subscription;
      },
      findMany: async () => [],
    },
    plan: {
      findUnique: async ({ where }: any) =>
        db.plans.find((p) => p.key === where.key_version.key && p.version === where.key_version.version) ?? null,
      findFirst: async ({ where, orderBy }: any) => {
        let rows = db.plans.filter((p) => (where.key ? p.key === where.key : true));
        if (where.status) rows = rows.filter((p) => p.status === where.status);
        rows = [...rows].sort((a, b) => b.version - a.version);
        return rows[0] ?? null;
      },
    },
    planVolumeOption: { findMany: async () => [] },
    planEntitlement: { findFirst: async () => null },
    subscriptionEvent: { create: async () => ({}) },
    pendingSubscriptionChange: { upsert: async () => ({}), deleteMany: async () => ({}), findMany: async () => [] },
    billingProfile: { findUnique: async () => ({ id: "bp-1", paymentMethods: [{ id: "pm-1" }] }) },
    publicEstimationConfig: { findFirst: async () => null },
  },
  materializeEntitlements: async () => {},
  rolloverIncluded: async (tenantId: string, _periodKey: string, allowance: number, _end: Date, source: string) => {
    rollovers.push({ tenantId, allowance, source });
  },
  grantUnits: async () => ({ lotId: "l" }),
  getBalance: async () => db.balance,
  expireDueLots: async () => ({ expiredLots: 0, expiredUnits: 0 }),
  refreshUsdIlsRate: async () => null,
  resolveEstimation: async () => ({
    chatCreditsPerEstimatedConversation: 8, voiceCreditsPerEstimatedCall: 20,
    businessDaysPerMonth: 25, version: 1, configId: "cfg", scope: "GLOBAL",
  }),
  estimatePlanCapacity: (i: any) => ({
    chat: { allocatedCredits: i.chatCredits, creditsPerUnit: 8, estimatedMonthly: i.chatCredits / 8, estimatedDaily: i.chatCredits / 8 / 25 },
    voice: { allocatedCredits: i.voiceCredits, creditsPerUnit: 20, estimatedMonthly: i.voiceCredits / 20, estimatedDaily: i.voiceCredits / 20 / 25 },
    estimatedTotalInteractions: i.chatCredits / 8 + i.voiceCredits / 20,
    ratios: i.ratios,
  }),
  estimatePricePerInteraction: () => ({ monthlyPrice: { minor: 0, currency: "USD" }, pricePerChat: null, pricePerCall: null, pricePerInteraction: null }),
  snapshotEstimation: (r: any) => ({ ...r, capturedAt: "2026-08-01T00:00:00.000Z" }),
  ratiosFromSnapshot: (_s: any, c: any) => c,
  toDisplayPrice: async (m: any) => ({
    base: { amount: (m.minor / 100).toFixed(2), currency: m.currency, formatted: `$${m.minor / 100}` },
    display: { amount: (m.minor / 100).toFixed(2), currency: m.currency, formatted: `$${m.minor / 100}` },
    isEstimatedConversion: false, chargedCurrency: m.currency, fx: null,
  }),
  money: (v: any, c = "USD") => ({ minor: Math.round(Number(v) * 100), currency: c }),
  toMinor: (v: any) => Math.round(Number(v) * 100),
  addMoney: (a: any, b: any) => ({ minor: a.minor + b.minor, currency: a.currency }),
  toDecimalString: (m: any) => (m.minor / 100).toFixed(2),
  isUnsellable: () => false,
  getFeatureDef: () => undefined,
}));

vi.mock("../services/billable-entity.service", () => ({
  ensureBillableEntity: async () => "entity-1",
  getEntityIdForTenant: async () => "entity-1",
  tenantsForEntity: async () => ["tenant-1"],
}));

vi.mock("../services/invoice.service", () => ({
  chargeFor: async (input: any) => {
    charges.push({ amount: input.amount, currency: input.currency, description: input.description });
    return chargeSucceeds ? { success: true, invoiceId: "inv-1" } : { success: false, invoiceId: "inv-1", failureCode: "declined" };
  },
}));

vi.mock("../services/tenant-status.service", () => ({ unsuspendTenants: async () => {} }));
vi.mock("../services/poc.service", () => ({ expireDuePocs: async () => 0 }));
vi.mock("../lib/events", () => ({ emitBillingEvent: async () => {} }));

import { activateOrRenew } from "../services/subscription.service";

function plan(over: Partial<any> = {}) {
  return {
    id: "plan-1", key: "ai_workforce", version: 1, name: "AI Workforce",
    basePrice: 499, currency: "USD", includedAiUnits: 2000, billingInterval: "MONTHLY",
    status: "ACTIVE", kind: "PUBLIC", chatVolumeEnabled: true, voiceVolumeEnabled: false,
    ...over,
  };
}

beforeEach(() => {
  charges.length = 0;
  rollovers.length = 0;
  subscriptionUpdates.length = 0;
  chargeSucceeds = true;
  db.plans = [plan()];
  db.subscription = {
    id: "sub-1",
    billableEntityId: "entity-1",
    planKey: "ai_workforce",
    planVersion: 1,
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-07-01"),
    currentPeriodEnd: new Date("2026-08-01"),
    snapshotPrice: 499,
    snapshotCurrency: "USD",
    snapshotIncludedCredits: 2000,
    snapshotEstimation: { chatCreditsPerEstimatedConversation: 8, voiceCreditsPerEstimatedCall: 20, businessDaysPerMonth: 25, version: 1 },
    snapshotAt: new Date("2026-07-01"),
    chatVolumeOptionKey: "chat_10",
    voiceVolumeOptionKey: null,
  };
});

describe("renewal charges the contracted snapshot", () => {
  it("charges the snapshot price", async () => {
    const r = await activateOrRenew("sub-1", { reason: "renewal" });
    expect(r.success).toBe(true);
    expect(charges).toHaveLength(1);
    expect(charges[0].amount).toBe(499);
  });

  /**
   * The whole point of plan versioning: an operator edits the live plan row and
   * the existing customer's renewal is unaffected.
   */
  it("ignores a price rise on the live plan row", async () => {
    db.plans = [plan({ basePrice: 999 })];
    await activateOrRenew("sub-1", { reason: "renewal" });
    expect(charges[0].amount).toBe(499);
    expect(charges[0].amount).not.toBe(999);
  });

  it("ignores a price CUT on the live plan row too", async () => {
    // Symmetry matters: the snapshot is the contract in both directions, so a
    // promotional price drop does not silently apply to existing customers
    // either. They move when they are migrated, not by side effect.
    db.plans = [plan({ basePrice: 199 })];
    await activateOrRenew("sub-1", { reason: "renewal" });
    expect(charges[0].amount).toBe(499);
  });

  it("grants the snapshot credit allowance, not the live plan's", async () => {
    db.plans = [plan({ includedAiUnits: 50_000 })];
    await activateOrRenew("sub-1", { reason: "renewal" });
    expect(rollovers).toHaveLength(1);
    expect(rollovers[0].allowance).toBe(2000);
  });

  it("charges the snapshot currency", async () => {
    db.plans = [plan({ currency: "ILS" })];
    await activateOrRenew("sub-1", { reason: "renewal" });
    expect(charges[0].currency).toBe("USD");
  });
});

describe("subscriptions without a snapshot fall back safely", () => {
  it("falls back to its OWN pinned plan version, not the newest", async () => {
    db.subscription.snapshotPrice = null;
    db.subscription.snapshotIncludedCredits = null;
    db.subscription.snapshotCurrency = null;
    // v1 is what the subscription points at; v2 is newer and more expensive.
    db.plans = [plan({ version: 1, basePrice: 499, includedAiUnits: 2000, status: "RETIRED" }), plan({ version: 2, basePrice: 999, includedAiUnits: 9000 })];
    await activateOrRenew("sub-1", { reason: "renewal" });
    expect(charges[0].amount).toBe(499);
    expect(rollovers[0].allowance).toBe(2000);
  });
});

describe("renewal failure does not grant anything", () => {
  it("marks PAST_DUE and grants no credits when the charge fails", async () => {
    chargeSucceeds = false;
    const r = await activateOrRenew("sub-1", { reason: "renewal" });
    expect(r.success).toBe(false);
    expect(db.subscription.status).toBe("PAST_DUE");
    // A failed renewal must not hand out another month of credits.
    expect(rollovers).toHaveLength(0);
  });
});

describe("sales-only plans skip charging", () => {
  it("activates without a charge when there is no price", async () => {
    db.subscription.snapshotPrice = null;
    db.plans = [plan({ basePrice: null })];
    const r = await activateOrRenew("sub-1", { reason: "renewal" });
    expect(r.success).toBe(true);
    expect(charges).toHaveLength(0);
    expect(rollovers).toHaveLength(1);
  });
});
