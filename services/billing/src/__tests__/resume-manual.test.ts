/**
 * A customer cannot resume what an operator set by hand (review 3, 2026-10-23).
 *
 * A console manual edit leaves renewal off and stores the plan's list price as
 * the snapshot; resuming would start charging it on the customer's click.
 * Mocks only - no database, no provider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ sub: null as any, events: [] as any[], cleared: 0 }));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    subscription: {
      findUnique: async () => H.sub,
      update: async ({ data }: any) => Object.assign(H.sub, data),
    },
    subscriptionEvent: {
      // The newest matching event, as `orderBy: { at: "desc" }` returns it.
      findFirst: async ({ where }: any) =>
        [...H.events].filter((e) => where.type.in.includes(e.type)).sort((a, b) => b.at - a.at)[0] ?? null,
      create: async () => {},
    },
    pendingSubscriptionChange: { deleteMany: async () => { H.cleared++; } },
  },
  materializeEntitlements: async () => {}, rolloverIncluded: async () => {}, rolloverIncludedOnce: async () => {},
  grantUnits: async () => {}, getBalance: async () => ({}), expireDueLots: async () => ({}), refreshUsdIlsRate: async () => {},
}));
vi.mock("../services/billable-entity.service", () => ({
  ensureBillableEntity: async () => "E", getEntityIdForTenant: async () => "E", tenantsForEntity: async () => ["T"],
}));
vi.mock("../services/plan.service", () => ({ getPlan: async () => null, getActivePlanVersion: async () => null, isUpgrade: () => false, assertSelectable: () => {} }));
vi.mock("../services/pricing.service", () => ({ quote: async () => ({}), snapshotFor: () => ({}) }));
vi.mock("../services/invoice.service", () => ({ chargeFor: () => { throw new Error("no charge here"); }, chargeFigures: async () => null, chargeRefusal: () => null }));
vi.mock("../services/tenant-status.service", () => ({ unsuspendTenants: async () => {} }));
vi.mock("../services/poc.service", () => ({ expireDuePocs: async () => 0, reconcileLiveEvaluations: async () => 0, provisionPoc: async () => ({}), PocProvisioningRefused: class extends Error {}, POC_FEATURE_DOMAINS: [] }));
vi.mock("../services/coupon.service", () => ({ resolveDiscount: async () => ({}), expireDueAssignments: async () => {} }));
vi.mock("../services/paid-provisioning.service", () => ({ resolveAndValidatePlan: async () => ({}), ProvisioningRefused: class extends Error {} }));
vi.mock("../lib/events", () => ({ emitBillingEvent: async () => {} }));

import { resumeSubscription } from "../services/subscription.service";

beforeEach(() => {
  H.sub = { id: "s1", status: "ACTIVE", cancelAtPeriodEnd: true };
  H.events = [];
  H.cleared = 0;
});

describe("resume", () => {
  for (const type of ["manual_plan_change", "manual_end_date", "manual_switch_to_poc"]) {
    it(`refuses when the terms were last set by ${type}; renewal stays off`, async () => {
      H.events = [{ type: "activated", at: 1 }, { type, at: 2 }];
      await expect(resumeSubscription({ tenantId: "T", actor: "owner" })).rejects.toThrow("manual_subscription");
      expect(H.sub.cancelAtPeriodEnd).toBe(true);
      expect(H.cleared).toBe(0);
    });
  }

  it("a customer's own cancel is still resumable", async () => {
    H.events = [{ type: "activated", at: 1 }, { type: "cancel_scheduled", at: 2 }];
    await resumeSubscription({ tenantId: "T", actor: "owner" });
    expect(H.sub.cancelAtPeriodEnd).toBe(false);
  });

  it("terms set by hand and later replaced through the product (a plan change) are resumable again", async () => {
    H.events = [{ type: "manual_plan_change", at: 1 }, { type: "plan_changed", at: 2 }];
    await resumeSubscription({ tenantId: "T", actor: "owner" });
    expect(H.sub.cancelAtPeriodEnd).toBe(false);
  });
});
