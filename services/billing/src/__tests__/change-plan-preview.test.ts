/**
 * ★ The change-plan preview shows exactly what change-plan would charge, and
 * a charge never differs from what the confirm showed (2026-10-08, design 17).
 *   - the preview's amount equals what chargeFor hands the provider, for the
 *     same inputs: ILS and USD plans, rates and prices that round at the cent
 *   - nothing charged now: a trial, an equal-price tier-up (immediate), going
 *     down (scheduled at period end)
 *   - refusals carry the charge's own codes (no rate, no billing country)
 *   - the preview writes nothing and never calls the provider
 *   - change-plan with the confirmed figure: a moved figure (price, rate,
 *     rate version) is refused before anything is written; moved in a race
 *     inside the charge, refused before the provider, and not reported as a
 *     failed payment
 * No database: a recording double stands in for prisma.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";

const H = vi.hoisted(() => ({
  writes: [] as string[],
  charged: [] as any[],
  events: [] as any[],
  sub: null as any,
  profile: null as any,
  plans: {} as Record<string, any>,
  newMinor: 0n,
  currency: "USD",
  rates: [] as Array<{ rate: string; version: number } | "none">,
  rateCalls: 0,
}));

const { prismaDouble } = vi.hoisted(() => {
const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;
const prismaDouble: any = new Proxy({}, {
  get(_t, model: string) {
    if (model === "$transaction") return async (fn: any) => { H.writes.push("$transaction"); return fn(prismaDouble); };
    return new Proxy({}, {
      get(_m, method: string) {
        return async (a: any) => {
          if (WRITE.test(method)) H.writes.push(`${model}.${method}`);
          if (model === "subscription" && method === "findUnique") return H.sub;
          if (model === "billingProfile" && method === "findUnique") return H.profile;
          if (model === "taxRate" && method === "findFirst") return a.where.countryCode === "IL" ? { percent: 18, label: "VAT", countryCode: "IL" } : null;
          if (model === "planVolumeOption" && method === "findMany") return [];
          if (model === "invoice" && method === "create") return { id: "inv1" };
          if (model === "charge" && method === "create") return { id: "ch1" };
          if (model === "paymentQuote" && method === "create") return { id: "q1", ...a.data };
          if (method === "updateMany") return { count: 1 };
          return method.startsWith("find") ? null : {};
        };
      },
    });
  },
});

  return { prismaDouble };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: prismaDouble,
    decryptPaymentToken: (t: string) => t,
    materializeEntitlements: async () => undefined,
    grantUnits: async () => undefined,
    getBalance: async () => ({ includedAllowance: 0 }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "owner" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/billable-entity.service", () => ({
  getEntityIdForTenant: async () => "ent1", ensureBillableEntity: async () => "ent1", tenantsForEntity: async () => ["T"], getSubscriptionForTenant: async () => H.sub,
}));
vi.mock("../services/plan.service", () => ({
  assertSelectable: async () => undefined,
  getActivePlanVersion: async (key: string) => H.plans[key] ?? null,
  getPlan: async (key: string) => H.plans[key] ?? null,
  isUpgrade: async (from: string, to: string) => (H.plans[to]?.rank ?? 0) > (H.plans[from]?.rank ?? 0),
  listActivePlans: async () => [],
}));
vi.mock("../services/pricing.service", () => ({
  quote: async () => ({ monthlyPrice: { minor: H.newMinor }, currency: H.currency, includedCredits: 100 }),
  snapshotFor: () => ({ snapshotPrice: "0" }),
}));
vi.mock("../services/exchange-rate.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    activeRate: async () => {
      const r = H.rates[Math.min(H.rateCalls++, H.rates.length - 1)];
      if (!r || r === "none") throw new actual.ExchangeRateUnavailable("no_usable_rate", "test");
      return { id: `rate${r.version}`, rate: new Prisma.Decimal(r.rate), version: r.version, source: "BOI" };
    },
  };
});
vi.mock("../lib/events", () => ({ emitBillingEvent: async (e: any) => { H.events.push(e); } }));
vi.mock("../services/tax-document.service", () => ({ issueTaxDocument: async () => null }));
vi.mock("../providers", () => ({
  getProvider: () => ({
    // Records what would be charged; nothing leaves the test.
    charge: async (a: any) => { H.charged.push(a); return { success: true, providerChargeId: "pc1", raw: {} }; },
  }),
}));
vi.mock("../services/tenant-status.service", () => ({ unsuspendTenants: async () => undefined }));
vi.mock("../services/poc.service", () => ({ expireDuePocs: async () => undefined, reconcileLiveEvaluations: async () => undefined }));
vi.mock("../services/coupon.service", () => ({ resolveDiscount: async () => null, expireDueAssignments: async () => undefined }));

import { previewPlanChange, changePlan } from "../services/subscription.service";
import subscriptionRouter from "../routes/subscription";

const plan = (key: string, rank: number, basePrice: number) => ({ id: `p_${key}`, key, version: 1, name: key, billingInterval: "MONTH", basePrice, rank, chatVolumeEnabled: false, voiceVolumeEnabled: false });

function setup(o: { current?: number; next?: number; currency?: string; rates?: Array<{ rate: string; version: number } | "none">; status?: string; country?: string | null; card?: boolean } = {}) {
  H.writes = []; H.charged = []; H.events = []; H.rateCalls = 0;
  H.plans = { starter: plan("starter", 1, o.current ?? 19.99), pro: plan("pro", 2, o.next ?? 49.99) };
  H.newMinor = BigInt(Math.round((o.next ?? 49.99) * 100));
  H.currency = o.currency ?? "USD";
  H.rates = o.rates ?? [{ rate: "3.6789", version: 7 }];
  H.sub = { id: "sub1", planKey: "starter", planVersion: 1, status: o.status ?? "ACTIVE", snapshotPrice: o.current ?? 19.99, chatVolumeOptionKey: null, voiceVolumeOptionKey: null,
    currentPeriodStart: new Date("2026-10-01T00:00:00Z"), currentPeriodEnd: new Date("2026-11-01T00:00:00Z") };
  H.profile = { id: "bp1", provider: "ICOUNT", currency: H.currency, billingCountry: o.country === undefined ? "IL" : o.country, billingName: "Acme", billingEmail: null, vatId: null, billingAddress: null, providerCustomerId: "c1",
    paymentMethods: o.card === false ? [] : [{ id: "pm1", token: "tok", status: "ACTIVE", isDefault: true, brand: "visa", last4: "4242" }] };
}
const input = (o: any = {}) => ({ tenantId: "T", targetPlanKey: "pro", actor: "owner", ...o });
const charge = async (o: any = {}) => { try { await changePlan(input(o)); return null; } catch (e: any) { return e.message as string; } };

beforeEach(() => setup());

describe("★ the preview is the charge", () => {
  const cases = [
    { name: "USD to ILS", current: 19.99, next: 49.99, currency: "USD", rate: "3.6789" },
    { name: "ILS, no conversion", current: 99, next: 149.9, currency: "ILS", rate: "1" },
    { name: "a rate that lands on half a cent", current: 10, next: 10.15, currency: "USD", rate: "3.3" },
    { name: "a float difference (0.3 - 0.1)", current: 0.1, next: 0.3, currency: "USD", rate: "2.9985" },
    { name: "a large upgrade", current: 199, next: 1999.99, currency: "EUR", rate: "4.0123" },
    // A contracted price with a third decimal: the commercial amount must be
    // rounded the same way on both paths (0.146 -> 0.15).
    { name: "a contracted price with a third decimal", current: 10.004, next: 10.15, currency: "USD", rate: "3.6789" },
  ];
  it.each(cases)("$name: the previewed gross is what the provider is asked to charge", async (c) => {
    setup({ current: c.current, next: c.next, currency: c.currency, rates: [{ rate: c.rate, version: 3 }] });
    const p = await previewPlanChange(input());
    expect(p.applied).toBe("immediate");
    expect(p.chargeNow).not.toBeNull();
    expect(p.chargeNow).toMatchObject({ chargeCurrency: "ILS", vatIncluded: true, taxPercent: 18, commercialCurrency: c.currency });
    // net + tax = gross, in the charge currency.
    expect(new Prisma.Decimal(p.chargeNow!.net).plus(p.chargeNow!.tax).toFixed(2)).toBe(p.chargeNow!.gross);
    setup({ current: c.current, next: c.next, currency: c.currency, rates: [{ rate: c.rate, version: 3 }] });
    expect(await charge()).toBeNull();
    expect(H.charged).toHaveLength(1);
    expect(H.charged[0].chargeAmount).toBe(p.chargeNow!.gross);
    expect(H.charged[0].chargeCurrency).toBe("ILS");
  });

  it("the worked example: 30.00 USD at 3.6789, 18% VAT", async () => {
    const p = await previewPlanChange(input());
    // 30.00 * 3.6789 = 110.367 -> 110.37 net; 18% = 19.8666 -> 19.87; gross 130.24.
    expect(p.chargeNow).toMatchObject({ commercialAmount: "30.00", net: "110.37", tax: "19.87", gross: "130.24", fxRateVersion: 7 });
    expect(p.newMonthly).toEqual({ amount: "49.99", currency: "USD" });
    expect(p.hasPaymentMethod).toBe(true);
  });
});

describe("★ nothing charged now", () => {
  it("a trial upgrades now with nothing charged; the change charges nothing either", async () => {
    setup({ status: "TRIALING" });
    expect(await previewPlanChange(input())).toMatchObject({ applied: "immediate", chargeNow: null, refused: null });
    setup({ status: "TRIALING" });
    expect(await charge()).toBeNull();
    expect(H.charged).toEqual([]);
  });

  it("an equal-price tier-up applies now, free", async () => {
    setup({ current: 49.99, next: 49.99 });
    expect(await previewPlanChange(input())).toMatchObject({ applied: "immediate", chargeNow: null });
  });

  it("going down is scheduled for the period's end", async () => {
    setup({ current: 49.99, next: 19.99 });
    H.plans.pro.rank = 0;
    expect(await previewPlanChange(input())).toMatchObject({ applied: "scheduled", chargeNow: null, effectiveAt: "2026-11-01T00:00:00.000Z", newMonthly: { amount: "19.99", currency: "USD" } });
  });
});

describe("★ refusals carry the charge's own codes", () => {
  it("no approved rate: charge_not_priceable / no_usable_rate, the code the charge records", async () => {
    setup({ rates: ["none"] });
    const p = await previewPlanChange(input());
    expect(p).toMatchObject({ chargeNow: null, refused: { code: "charge_not_priceable", reason: "no_usable_rate" } });
    setup({ rates: ["none"] });
    expect(await charge()).toBe("upgrade_payment_failed:charge_not_priceable: no_usable_rate");
  });

  it("no billing country: charge_not_taxable / tax_country_undeclared, the code the charge records", async () => {
    setup({ country: null });
    expect((await previewPlanChange(input())).refused).toEqual({ code: "charge_not_taxable", reason: "tax_country_undeclared" });
    setup({ country: null });
    expect(await charge()).toBe("upgrade_payment_failed:charge_not_taxable: tax_country_undeclared");
  });

  it("no card: the figure, and that the charge would fail", async () => {
    setup({ card: false });
    expect(await previewPlanChange(input())).toMatchObject({ hasPaymentMethod: false, chargeNow: { gross: "130.24" } });
  });
});

describe("★ the preview has no side effect", () => {
  it("no write of any kind, and never the provider, whatever the outcome", async () => {
    for (const o of [{}, { status: "TRIALING" }, { rates: ["none"] as any }, { country: null }, { current: 49.99, next: 19.99 }]) {
      setup(o);
      await previewPlanChange(input());
      expect(H.writes).toEqual([]);
      expect(H.charged).toEqual([]);
      expect(H.events).toEqual([]);
    }
  });
});

describe("★ the charge never differs from the confirm", () => {
  it("the confirmed figure: charged exactly that, with the figure in the idempotency key", async () => {
    expect(await charge({ expectedChargeAmount: "130.24", expectedFxRateVersion: 7 })).toBeNull();
    expect(H.charged[0]).toMatchObject({ chargeAmount: "130.24" });
    expect(H.charged[0].idempotencyKey).toMatch(/:130\.24$/);
  });

  it("a moved price, rate or rate version: refused before anything is written or charged", async () => {
    expect(await charge({ expectedChargeAmount: "129.00" })).toBe("charge_amount_changed");
    expect(H.writes).toEqual([]);
    expect(H.charged).toEqual([]);
    setup();
    expect(await charge({ expectedChargeAmount: "130.24", expectedFxRateVersion: 6 })).toBe("charge_amount_changed");
    expect(H.charged).toEqual([]);
  });

  it("moved inside the charge (a new rate between check and charge): refused before the provider, not a failed payment", async () => {
    setup({ rates: [{ rate: "3.6789", version: 7 }, { rate: "3.7", version: 8 }] });
    expect(await charge({ expectedChargeAmount: "130.24", expectedFxRateVersion: 7 })).toBe("charge_amount_changed");
    expect(H.charged).toEqual([]);
    expect(H.events.filter((e) => e.type === "payment.failed")).toEqual([]);
  });

  it("without a confirmed figure, change-plan behaves as before", async () => {
    expect(await charge()).toBeNull();
    expect(H.charged[0].idempotencyKey).not.toMatch(/:130\.24$/);
  });
});

describe("★ the routes", () => {
  const app = express();
  app.use(express.json());
  app.use(subscriptionRouter);

  it("POST /billing/subscription/change-plan/preview answers the preview", async () => {
    const r = await request(app).post("/billing/subscription/change-plan/preview").send({ planKey: "pro" });
    expect(r.status).toBe(200);
    expect(r.body.preview).toMatchObject({ applied: "immediate", chargeNow: { gross: "130.24", chargeCurrency: "ILS", vatIncluded: true } });
    expect(H.writes).toEqual([]);
  });

  it("change-plan with a moved figure: 409 charge_amount_changed with the new preview", async () => {
    const r = await request(app).post("/billing/subscription/change-plan").send({ planKey: "pro", expectedChargeAmount: "120.00", expectedFxRateVersion: 7 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "charge_amount_changed", preview: { chargeNow: { gross: "130.24" } } });
    expect(H.charged).toEqual([]);
  });
});
