/**
 * AI credits reset EVERY month, whatever the billing period's length (Omer,
 * 2026-10-07). The dev wallet sat at 0 from August because a one-year period
 * only granted at its start.
 *
 * Unit-level and database-free on purpose: the real wallet code
 * (rolloverIncludedOnce + grant + snapshot) runs against an in-memory client,
 * and rollMonthlyCredits runs against an in-memory subscription. Run with
 * vitest.unit.config.ts so no global setup touches the shared database.
 *
 *   - a one-year period across 3 months = 3 monthly allocations
 *   - no accumulation: a new month expires the last month's included remainder
 *   - idempotent: two ticks in one month = one allocation
 *   - purchased / promo credits are never touched
 *   - a one-month period is unchanged (the renewal's grant is the month's)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ lots: [] as any[], ledger: [] as any[], balance: new Map<string, any>(), subs: [] as any[], seq: 0 }));

function makeClient() {
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("not" in v) return row[k] !== v.not;
      if ("gt" in v) return Number(row[k]) > v.gt;
      return true;
    }
    return (row[k] ?? null) === v;
  });
  const tx: any = {
    $executeRaw: async () => 1,
    aiUnitLot: {
      findFirst: async (a: any) => H.lots.find((l) => matches(l, a.where)) ?? null,
      findMany: async (a: any) => H.lots.filter((l) => matches(l, a.where)).map((l) => ({ ...l })),
      update: async (a: any) => { const l = H.lots.find((x) => x.id === a.where.id); Object.assign(l, a.data); return l; },
      create: async (a: any) => { const l = { id: `lot${++H.seq}`, ...a.data }; H.lots.push(l); return l; },
    },
    aiUnitLedgerEntry: { create: async (a: any) => { H.ledger.push(a.data); return a.data; } },
    tenantAiBalance: {
      findUnique: async (a: any) => H.balance.get(a.where.tenantId) ?? null,
      upsert: async (a: any) => { const v = { ...(H.balance.get(a.where.tenantId) ?? a.create), ...(H.balance.has(a.where.tenantId) ? a.update : {}) }; H.balance.set(a.where.tenantId, v); return v; },
    },
  };
  tx.$transaction = async (fn: any) => fn(tx);
  return tx;
}
const CLIENT = vi.hoisted(() => ({ c: null as any }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    // The REAL once-per-month rollover, on the in-memory client.
    rolloverIncludedOnce: (t: string, k: string, a: number, e: Date, s: string) => actual.rolloverIncludedOnce(t, k, a, e, s, CLIENT.c),
    prisma: {
      subscription: { findMany: async () => H.subs.map((s) => ({ ...s })) },
    },
  };
});
vi.mock("../services/plan.service", () => ({
  getPlan: async () => ({ key: "ai_voice", includedAiUnits: 7000 }),
  getActivePlanVersion: async () => 1, isUpgrade: () => false, assertSelectable: () => undefined,
}));
vi.mock("../services/billable-entity.service", () => ({
  tenantsForEntity: async () => ["T"], ensureBillableEntity: async () => "E", getEntityIdForTenant: async () => "E",
}));

import { rollMonthlyCredits } from "../services/subscription.service";
import { creditMonthOf } from "../lib/period";

const included = () => H.lots.filter((l) => l.bucket === "INCLUDED");
const remainingIncluded = () => included().reduce((s, l) => s + Number(l.unitsRemaining), 0);

beforeEach(() => {
  H.lots = [
    // The PROMO grant on dev: purchased bucket, no expiry.
    { id: "promo", tenantId: "T", bucket: "PURCHASED", grantType: "PROMO", unitsGranted: "2000", unitsRemaining: "1964.919099", periodKey: null, expiresAt: null },
    // The first month's allowance, granted at the period start and used up.
    { id: "jul", tenantId: "T", bucket: "INCLUDED", grantType: "PLAN", unitsGranted: "7000", unitsRemaining: "0", periodKey: "2026-09", expiresAt: null },
  ];
  H.ledger = []; H.balance = new Map(); H.seq = 0;
  // A one-year period starting 8 Sep 2026 (the dev subscription's shape).
  H.subs = [{ id: "s1", billableEntityId: "E", planKey: "ai_voice", planVersion: 1, currentPeriodStart: new Date("2026-09-08T14:19:24Z"), currentPeriodEnd: new Date("2027-09-08T14:19:24Z"), snapshotIncludedCredits: 7000 }];
  CLIENT.c = makeClient();
});

describe("creditMonthOf (pure)", () => {
  const start = new Date("2026-09-08T14:19:24Z");
  const end = new Date("2027-09-08T14:19:24Z");
  it("months count from the period's anchor day", () => {
    expect(creditMonthOf(start, end, new Date("2026-10-07T12:00:00Z")).key).toBe("2026-09");
    expect(creditMonthOf(start, end, new Date("2026-10-08T15:00:00Z")).key).toBe("2026-10");
    expect(creditMonthOf(start, end, new Date("2026-12-31T00:00:00Z"))).toMatchObject({ key: "2026-12", end: new Date("2027-01-08T14:19:24Z") });
  });
  it("a one-month period IS its credit month (same key as the renewal's)", () => {
    const mEnd = new Date("2026-10-08T14:19:24Z");
    expect(creditMonthOf(start, mEnd, new Date("2026-09-20T00:00:00Z"))).toMatchObject({ key: "2026-09", end: mEnd });
  });
  it("an anchor on the 31st clamps to short months and never ends past the period", () => {
    const a = new Date("2027-01-31T10:00:00Z");
    expect(creditMonthOf(a, null, new Date("2027-03-01T00:00:00Z")).start).toEqual(new Date("2027-02-28T10:00:00Z"));
    expect(creditMonthOf(a, new Date("2027-02-15T00:00:00Z"), new Date("2027-02-01T00:00:00Z")).end).toEqual(new Date("2027-02-15T00:00:00Z"));
  });
});

describe("★ rollMonthlyCredits", () => {
  it("★ a one-year period across 3 months gets 3 monthly allocations, never accumulated", async () => {
    // Month 1 (Sep 8 - Oct 8): already granted at the period start.
    expect(await rollMonthlyCredits(new Date("2026-10-07T12:00:00Z"))).toBe(0);
    // Months 2, 3, 4.
    for (const at of ["2026-10-09T00:00:00Z", "2026-11-09T00:00:00Z", "2026-12-09T00:00:00Z"]) {
      expect(await rollMonthlyCredits(new Date(at))).toBe(1);
      // No accumulation: only this month's allowance remains included.
      expect(remainingIncluded()).toBe(7000);
    }
    expect(included().filter((l) => l.grantType === "PLAN").map((l) => l.periodKey)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
    // The month before each new one was expired with an EXPIRE ledger entry.
    expect(H.ledger.filter((e) => e.entryType === "EXPIRE").map((e) => e.periodKey)).toEqual(["2026-10", "2026-11"]);
  });

  it("★ idempotent: two ticks in the same month grant once", async () => {
    expect(await rollMonthlyCredits(new Date("2026-10-09T00:00:00Z"))).toBe(1);
    expect(await rollMonthlyCredits(new Date("2026-10-20T00:00:00Z"))).toBe(0);
    expect(included().filter((l) => l.periodKey === "2026-10")).toHaveLength(1);
    expect(remainingIncluded()).toBe(7000);
  });

  it("★ the PROMO grant survives every reset", async () => {
    await rollMonthlyCredits(new Date("2026-10-09T00:00:00Z"));
    await rollMonthlyCredits(new Date("2026-11-09T00:00:00Z"));
    expect(H.lots.find((l) => l.id === "promo")).toMatchObject({ bucket: "PURCHASED", unitsRemaining: "1964.919099" });
    expect(H.balance.get("T")).toMatchObject({ includedRemaining: "7000.000000", periodKey: "2026-11" });
    expect(Number(H.balance.get("T").purchasedRemaining)).toBeCloseTo(1964.919099, 5);
  });

  it("a one-month period is left to its renewal (no extra grant)", async () => {
    H.subs[0].currentPeriodEnd = new Date("2026-10-08T14:19:24Z");
    expect(await rollMonthlyCredits(new Date("2026-09-20T00:00:00Z"))).toBe(0);
    // Past its end the renewal owns it, not this sweep.
    expect(await rollMonthlyCredits(new Date("2026-10-09T00:00:00Z"))).toBe(0);
  });
});
