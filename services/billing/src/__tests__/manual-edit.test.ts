/**
 * Console manual edits never charge, and leave nothing behind that would
 * (Omer, 2026-10-23).
 *
 * Pure unit tests over an in-memory store: no database, no provider. Dev's
 * iCount is production's, so nothing here may reach a real charging path - the
 * invoice module is replaced with one that fails the test if it is called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({
  tenants: new Set<string>(),
  subs: [] as any[],
  pending: [] as any[],
  dunning: [] as any[],
  shopify: [] as any[],
  checkouts: [] as any[],
  entitlements: [] as any[],
  events: [] as any[],
  grants: [] as any[],
  plans: [] as any[],
  provisionPoc: [] as any[],
  charges: 0,
}));

vi.mock("../services/invoice.service", () => ({
  chargeFor: () => { H.charges++; throw new Error("chargeFor must never be called by a manual edit"); },
}));

vi.mock("../services/billable-entity.service", () => ({
  getEntityIdForTenant: async (t: string) => (H.tenants.has(t) ? `E_${t}` : null),
  ensureBillableEntity: async (t: string) => `E_${t}`,
  tenantsForEntity: async (e: string) => [e.slice(2)],
}));

vi.mock("../services/paid-provisioning.service", () => {
  class ProvisioningRefused extends Error { constructor(readonly code: string) { super(code); } }
  return {
    ProvisioningRefused,
    resolveAndValidatePlan: async ({ planVersionId }: any) => {
      const p = H.plans.find((x) => x.id === planVersionId);
      if (!p) throw new ProvisioningRefused("plan_version_not_found");
      return p;
    },
  };
});

vi.mock("../services/pricing.service", () => ({
  quote: async ({ planKey }: any) => ({ planKey, includedCredits: 1000, monthlyPrice: { currency: "ILS" } }),
  snapshotFor: () => ({ snapshotPrice: "490.00", snapshotCurrency: "ILS", snapshotIncludedCredits: 1000 }),
}));

vi.mock("../services/poc.service", () => {
  class PocProvisioningRefused extends Error { constructor(readonly code: string) { super(code); } }
  return {
    PocProvisioningRefused,
    provisionPoc: async (input: any) => {
      H.provisionPoc.push(input);
      // What setupPoc writes: no price, out of the renewal sweep.
      const sub = H.subs.find((s) => s.billableEntityId === `E_${input.tenantId}`);
      Object.assign(sub ?? (H.subs.push({ id: "sub_poc", billableEntityId: `E_${input.tenantId}` }), H.subs[H.subs.length - 1]), {
        planKey: "poc", planVersion: 1, status: "ACTIVE", cancelAtPeriodEnd: true, trialEndsAt: null,
        currentPeriodEnd: input.expiresAt, snapshotPrice: null,
      });
      H.tenants.add(input.tenantId);
      return { featuresEnabled: input.features, featuresDenied: [] };
    },
  };
});

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("notIn" in v) return !v.notIn.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
    }
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    return row[k] === v;
  });
}

vi.mock("@chatcenter/shared", () => {
  const db: any = {
    tenant: { findUnique: async ({ where }: any) => (H.tenants.has(where.id) ? { id: where.id } : null) },
    plan: { findFirst: async ({ where }: any) => H.plans.find((p) => p.key === where.key && p.version === where.version) ?? null },
    providerSubscription: { findFirst: async ({ where }: any) => H.shopify.find((r) => matches(r, where)) ?? null },
    dunningState: { findUnique: async ({ where }: any) => H.dunning.find((d) => d.subscriptionId === where.subscriptionId) ?? null },
    pendingCheckout: { findFirst: async ({ where }: any) => H.checkouts.find((c) => matches(c, where)) ?? null },
    subscription: {
      findUnique: async ({ where }: any) => H.subs.find((s) => s.billableEntityId === where.billableEntityId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const s = H.subs.find((x) => x.billableEntityId === where.billableEntityId);
        if (s) return Object.assign(s, update);
        const n = { id: `sub_${H.subs.length + 1}`, ...create };
        H.subs.push(n);
        return n;
      },
      update: async ({ where, data }: any) => Object.assign(H.subs.find((s) => s.id === where.id), data),
    },
    pendingSubscriptionChange: {
      findUnique: async ({ where }: any) => H.pending.find((p) => p.subscriptionId === where.subscriptionId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const p = H.pending.find((x) => x.subscriptionId === where.subscriptionId);
        if (p) return Object.assign(p, update);
        H.pending.push({ appliedAt: null, targetPlanKey: null, ...create });
        return H.pending[H.pending.length - 1];
      },
      deleteMany: async ({ where }: any) => { H.pending = H.pending.filter((p) => !matches(p, where)); },
    },
    tenantEntitlement: {
      updateMany: async ({ where, data }: any) => {
        for (const e of H.entitlements) if (matches(e, where)) Object.assign(e, data);
      },
    },
    subscriptionEvent: { create: async ({ data }: any) => { H.events.push(data); } },
  };
  db.$transaction = async (fn: any) => fn(db);
  return {
    prisma: db,
    grantUnits: async (g: any) => { H.grants.push(g); },
    getBalance: async () => ({ includedAllowance: 200, purchasedRemaining: 0, total: 200 }),
    materializeEntitlements: async () => {},
    periodKeyFor: (d: Date) => d.toISOString().slice(0, 10),
  };
});

import {
  manualChangePlan,
  manualSetEndDate,
  manualSwitchToPoc,
  manualAddCredits,
  ManualEditRefused,
} from "../services/manual-edit.service";

const NOW = new Date("2026-10-23T12:00:00Z");
const LATER = new Date("2026-12-31T00:00:00Z");
const PAST = new Date("2026-10-01T00:00:00Z");

function paidSub(over: Record<string, unknown> = {}) {
  H.tenants.add("T");
  H.subs.push({
    id: "sub_T", billableEntityId: "E_T", planKey: "starter", planVersion: 1, status: "ACTIVE",
    cancelAtPeriodEnd: false, trialEndsAt: null, currentPeriodStart: new Date("2026-10-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"), snapshotPrice: "190.00", snapshotCurrency: "ILS",
    billingSource: "GOTCHA_EXTERNAL", ...over,
  });
}

/** The renewal and trial sweeps' selections, as runBillingCycle writes them. */
function renewalWouldCharge(s: any, at: Date): boolean {
  return s.status === "ACTIVE" && s.cancelAtPeriodEnd === false && s.currentPeriodEnd <= at;
}
function trialWouldCharge(s: any, at: Date): boolean {
  return s.status === "TRIALING" && s.trialEndsAt && s.trialEndsAt <= at;
}

beforeEach(() => {
  H.tenants = new Set(); H.subs = []; H.pending = []; H.dunning = []; H.shopify = []; H.checkouts = [];
  H.entitlements = []; H.events = []; H.grants = []; H.provisionPoc = []; H.charges = 0;
  H.plans = [
    { id: "pv_starter", key: "starter", version: 1, kind: "PUBLIC", billingInterval: "MONTHLY" },
    { id: "pv_growth", key: "growth", version: 2, kind: "PUBLIC", billingInterval: "MONTHLY" },
    { key: "poc", version: 1, kind: "POC" },
  ];
});

describe("change_plan", () => {
  it("moves the plan and switches renewal off: no sweep would ever charge it", async () => {
    paidSub();
    const r = await manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: LATER, actor: "sa", reason: "deal" }, NOW);
    const s = H.subs[0];
    expect(s).toMatchObject({ planKey: "growth", planVersion: 2, status: "ACTIVE", cancelAtPeriodEnd: true, trialEndsAt: null, currentPeriodEnd: LATER });
    // At the end date and long after it, neither the renewal nor the trial sweep selects it.
    for (const at of [LATER, new Date("2030-01-01T00:00:00Z")]) {
      expect(renewalWouldCharge(s, at)).toBe(false);
      expect(trialWouldCharge(s, at)).toBe(false);
    }
    // Access ends on the chosen date instead of renewing.
    expect(H.pending).toEqual([expect.objectContaining({ subscriptionId: "sub_T", changeType: "CANCEL", effectiveAt: LATER, appliedAt: null })]);
    expect(r).toMatchObject({ renewal: "off", charges: "none", before: { planKey: "starter", cancelAtPeriodEnd: false }, after: { planKey: "growth", cancelAtPeriodEnd: true } });
    expect(H.charges).toBe(0);
  });

  it("a trial being converted is charged at trialEndsAt whatever cancelAtPeriodEnd says, so the edit ends the trial", async () => {
    paidSub({ status: "TRIALING", trialEndsAt: new Date("2026-10-25T00:00:00Z") });
    await manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: LATER, reason: "r" }, NOW);
    expect(H.subs[0]).toMatchObject({ status: "ACTIVE", trialEndsAt: null });
    expect(trialWouldCharge(H.subs[0], LATER)).toBe(false);
  });

  it("replaces a pending downgrade, and reports the one it cleared", async () => {
    paidSub();
    H.pending.push({ subscriptionId: "sub_T", changeType: "DOWNGRADE", targetPlanKey: "starter", targetPlanVersion: 1, effectiveAt: new Date("2026-11-01T00:00:00Z"), appliedAt: null });
    const r = await manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: LATER, reason: "r" }, NOW);
    expect(r.pendingChangeCleared).toMatchObject({ changeType: "DOWNGRADE", targetPlanKey: "starter" });
    expect(H.pending).toHaveLength(1);
    expect(H.pending[0]).toMatchObject({ changeType: "CANCEL", targetPlanKey: null, targetPlanVersion: null, effectiveAt: LATER });
  });

  it("keeps a live period's end when none is given", async () => {
    paidSub();
    await manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", reason: "r" }, NOW);
    expect(H.subs[0].currentPeriodEnd).toEqual(new Date("2026-11-01T00:00:00Z"));
  });

  it("creates the subscription for an organization with no plan, and still needs an end date", async () => {
    H.tenants.add("T");
    await expect(manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", reason: "r" }, NOW)).rejects.toMatchObject({ code: "end_date_required" });
    await manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: LATER, reason: "r" }, NOW);
    expect(H.subs[0]).toMatchObject({ planKey: "growth", status: "ACTIVE", cancelAtPeriodEnd: true, enforcementEnabled: true });
  });

  it("tops the included allowance up to the plan's figure, never past it", async () => {
    paidSub();
    await manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: LATER, reason: "r" }, NOW);
    expect(H.grants).toEqual([expect.objectContaining({ bucket: "INCLUDED", units: 800, includedAllowance: 1000 })]);
  });

  it("warns that a customer completing an open checkout would replace the plan", async () => {
    paidSub();
    H.checkouts.push({ tenantId: "T", status: "PENDING" });
    const r = await manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: LATER, reason: "r" }, NOW);
    expect(r.warnings).toContain("open_checkout");
  });
});

describe("refusals: nothing is written", () => {
  const cases: Array<[string, () => void, string]> = [
    ["Shopify-billed (provider subscription)", () => { paidSub(); H.shopify.push({ tenantId: "T", billingSource: "SHOPIFY", status: "ACTIVE" }); }, "shopify_billed"],
    ["Shopify-billed (subscription source)", () => paidSub({ billingSource: "SHOPIFY" }), "shopify_billed"],
    ["in dunning", () => paidSub({ status: "PAST_DUE" }), "in_dunning"],
    ["dunning row on an ACTIVE subscription", () => { paidSub(); H.dunning.push({ subscriptionId: "sub_T" }); }, "in_dunning"],
    ["grandfathered", () => paidSub({ status: "GRANDFATHERED" }), "grandfathered"],
    ["suspended", () => paidSub({ status: "SUSPENDED" }), "subscription_state_not_editable"],
  ];
  for (const [name, setup, code] of cases) {
    it(`${name} -> ${code}`, async () => {
      setup();
      const before = JSON.stringify(H.subs);
      for (const run of [
        () => manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: LATER, reason: "r" }, NOW),
        () => manualSetEndDate({ tenantId: "T", endsAt: LATER, reason: "r" }, NOW),
        () => manualSwitchToPoc({ tenantId: "T", credits: 100, expiresAt: LATER, features: ["ai"], reason: "r" }, NOW),
      ]) {
        await expect(run()).rejects.toMatchObject({ code });
      }
      expect(JSON.stringify(H.subs)).toBe(before);
      expect(H.pending).toEqual([]);
      expect(H.provisionPoc).toEqual([]);
    });
  }

  it("a past end date is refused on every action that takes one", async () => {
    paidSub();
    await expect(manualChangePlan({ tenantId: "T", planVersionId: "pv_growth", endsAt: PAST, reason: "r" }, NOW)).rejects.toMatchObject({ code: "end_date_in_past" });
    await expect(manualSetEndDate({ tenantId: "T", endsAt: PAST, reason: "r" }, NOW)).rejects.toMatchObject({ code: "end_date_in_past" });
    await expect(manualSwitchToPoc({ tenantId: "T", credits: 10, expiresAt: PAST, features: ["ai"], reason: "r" }, NOW)).rejects.toMatchObject({ code: "end_date_in_past" });
    expect(H.subs[0].currentPeriodEnd).toEqual(new Date("2026-11-01T00:00:00Z"));
  });

  it("an unknown tenant", async () => {
    await expect(manualAddCredits({ tenantId: "nope", units: 5, reason: "r" })).rejects.toBeInstanceOf(ManualEditRefused);
  });
});

describe("set_end_date", () => {
  it("a paid plan: the new end is a scheduled cancel, renewal off", async () => {
    paidSub();
    const r = await manualSetEndDate({ tenantId: "T", endsAt: LATER, reason: "r" }, NOW);
    expect(H.subs[0]).toMatchObject({ currentPeriodEnd: LATER, cancelAtPeriodEnd: true, status: "ACTIVE" });
    expect(renewalWouldCharge(H.subs[0], LATER)).toBe(false);
    expect(H.pending[0]).toMatchObject({ changeType: "CANCEL", effectiveAt: LATER });
    expect(r.renewal).toBe("off");
  });

  it("a trial awaiting conversion stops being one, so trialEndsAt cannot charge it", async () => {
    paidSub({ status: "TRIALING", trialEndsAt: new Date("2026-10-25T00:00:00Z") });
    await manualSetEndDate({ tenantId: "T", endsAt: LATER, reason: "r" }, NOW);
    expect(H.subs[0]).toMatchObject({ status: "ACTIVE", trialEndsAt: null, cancelAtPeriodEnd: true });
    expect(trialWouldCharge(H.subs[0], LATER)).toBe(false);
  });

  it("an ended POC is revived, and its feature grants move with it", async () => {
    const oldEnd = new Date("2026-10-20T00:00:00Z");
    H.tenants.add("T");
    H.subs.push({ id: "sub_T", billableEntityId: "E_T", planKey: "poc", planVersion: 1, status: "CANCELED", cancelAtPeriodEnd: true, currentPeriodEnd: oldEnd });
    H.entitlements.push(
      { tenantId: "T", source: "TRIAL", expiresAt: oldEnd, key: "ai" },
      { tenantId: "T", source: "TRIAL", expiresAt: new Date("2027-01-01T00:00:00Z"), key: "other-grant" },
      { tenantId: "T", source: "OVERRIDE", expiresAt: oldEnd, key: "override" },
    );
    await manualSetEndDate({ tenantId: "T", endsAt: LATER, reason: "two more weeks" }, NOW);
    expect(H.subs[0]).toMatchObject({ status: "ACTIVE", currentPeriodEnd: LATER, cancelAtPeriodEnd: true });
    expect(H.entitlements.map((e) => e.expiresAt)).toEqual([LATER, new Date("2027-01-01T00:00:00Z"), oldEnd]);
    // The expiry sweep ends a POC by itself; no pending row is added for it.
    expect(H.pending).toEqual([]);
  });

  it("an organization with no subscription has no end date to move", async () => {
    H.tenants.add("T");
    await expect(manualSetEndDate({ tenantId: "T", endsAt: LATER, reason: "r" }, NOW)).rejects.toMatchObject({ code: "no_subscription" });
  });
});

describe("switch_to_poc", () => {
  it("goes through the one POC path, after clearing a pending change", async () => {
    paidSub();
    H.pending.push({ subscriptionId: "sub_T", changeType: "DOWNGRADE", targetPlanKey: "starter", effectiveAt: LATER, appliedAt: null });
    const r = await manualSwitchToPoc({ tenantId: "T", credits: 500, expiresAt: LATER, features: ["ai", "conversation"], actor: "sa", reason: "pilot" }, NOW);
    expect(H.pending).toEqual([]);
    expect(H.provisionPoc).toEqual([expect.objectContaining({ tenantId: "T", credits: 500, expiresAt: LATER, features: ["ai", "conversation"], note: "pilot" })]);
    expect(r).toMatchObject({ renewal: "off", charges: "none", after: { planKey: "poc", cancelAtPeriodEnd: true }, pendingChangeCleared: { changeType: "DOWNGRADE" } });
    expect(renewalWouldCharge(H.subs[0], new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("add_credits", () => {
  it("PURCHASED promo credits; the renewal is not touched and not claimed off", async () => {
    paidSub();
    const r = await manualAddCredits({ tenantId: "T", units: 250, actor: "sa", reason: "goodwill" });
    expect(H.grants).toEqual([expect.objectContaining({ bucket: "PURCHASED", grantType: "PROMO", units: 250, source: "admin:sa" })]);
    expect(H.subs[0].cancelAtPeriodEnd).toBe(false);
    expect(r.renewal).toBe("unchanged");
  });

  it("refuses a fractional or non-positive amount", async () => {
    paidSub();
    await expect(manualAddCredits({ tenantId: "T", units: 0, reason: "r" })).rejects.toMatchObject({ code: "units_must_be_positive" });
    await expect(manualAddCredits({ tenantId: "T", units: 1.5, reason: "r" })).rejects.toMatchObject({ code: "units_must_be_positive" });
  });
});

describe("the sweeps these tests model are the sweeps that run", () => {
  // renewalWouldCharge / trialWouldCharge above restate runBillingCycle's
  // selections. If the cycle changes how it picks what to charge, this fails
  // and the guarantee above has to be re-proved, not assumed.
  const src = readFileSync(join(__dirname, "../services/subscription.service.ts"), "utf8");
  it("renewal selects ACTIVE, cancelAtPeriodEnd=false, period ended", () => {
    expect(src).toContain('prisma.subscription.findMany({ where: { status: "ACTIVE", cancelAtPeriodEnd: false, currentPeriodEnd: { lte: now } } })');
  });
  it("trial conversion selects TRIALING with trialEndsAt passed", () => {
    expect(src).toContain('prisma.subscription.findMany({ where: { status: "TRIALING", trialEndsAt: { lte: now } } })');
  });
  it("the manual-edit service never imports the charging module", () => {
    const svc = readFileSync(join(__dirname, "../services/manual-edit.service.ts"), "utf8");
    expect(svc).not.toMatch(/invoice\.service|chargeFor\(/);
  });
});
