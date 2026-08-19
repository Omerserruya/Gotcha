/**
 * Tax pricing.
 *
 * Catalogue prices are NET, so the amount charged is not the amount displayed
 * and the document has to carry both plus the rate between them. These cover
 * the arithmetic and the refusal, which are the two things that cost money
 * when they are wrong.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { taxRate } = vi.hoisted(() => ({ taxRate: { findFirst: vi.fn() } }));

vi.mock("@chatcenter/shared", async () => ({
  // Real coupon arithmetic, not stubs: it is pure, and a stub here would
  // make the discount path this file exercises meaningless.
  ...(await import("../../../../packages/shared/src/lib/billing/coupon")),
  prisma: { taxRate },
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: () => "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
}));

import { resolveTaxRate, applyTax, taxForProfile, taxForDisplay, TaxCountryUndeclared } from "../services/tax.service";

const IL = { countryCode: "IL", percent: 18, label: 'מע"מ', exempt: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolving a rate", () => {
  it("reads the configured rate for a country", async () => {
    taxRate.findFirst.mockResolvedValue({ countryCode: "IL", percent: "18.00", label: 'מע"מ', active: true });
    expect(await resolveTaxRate("il")).toEqual(IL);
  });

  it("treats an unconfigured country as 0%, which is how everywhere-but-Israel is expressed", async () => {
    taxRate.findFirst.mockResolvedValue(null);
    const r = await resolveTaxRate("US");
    expect(r).toEqual({ countryCode: "US", percent: 0, label: null, exempt: true });
  });

  it("only reads ACTIVE rows, so retiring a rate is a flag not a delete", async () => {
    taxRate.findFirst.mockResolvedValue(null);
    await resolveTaxRate("IL");
    expect(taxRate.findFirst).toHaveBeenCalledWith({ where: { countryCode: "IL", active: true } });
  });

  it("refuses an empty country rather than guessing", async () => {
    await expect(resolveTaxRate("")).rejects.toBeInstanceOf(TaxCountryUndeclared);
  });
});

describe("the arithmetic", () => {
  it("adds 18% to a net amount", () => {
    const t = applyTax("100.00", IL);
    expect(t).toMatchObject({ net: "100.00", tax: "18.00", gross: "118.00", percent: 18 });
  });

  it("charges the net amount unchanged where nothing is owed", () => {
    const t = applyTax("39.00", { countryCode: "US", percent: 0, label: null, exempt: true });
    expect(t).toMatchObject({ net: "39.00", tax: "0.00", gross: "39.00", exempt: true });
  });

  it("always adds up: net + tax === gross", () => {
    for (const net of ["1.00", "39.00", "97.00", "229.00", "0.01", "1995.00", "33.33"]) {
      const t = applyTax(net, IL);
      expect(Number(t.net) + Number(t.tax), `net+tax must equal gross for ${net}`).toBeCloseTo(Number(t.gross), 2);
    }
  });

  it("rounds the tax half-up at two decimals", () => {
    // 0.01 * 18% = 0.0018 -> 0.00; 2.75 * 18% = 0.495 -> 0.50 (half-up, not down)
    expect(applyTax("0.01", IL).tax).toBe("0.00");
    expect(applyTax("2.75", IL).tax).toBe("0.50");
  });

  it("derives the tax from the NET, never back out of a rounded gross", () => {
    // Deriving backwards is how three numbers on one document stop reconciling.
    const t = applyTax("1.00", IL);
    expect(t.tax).toBe("0.18");
    expect(t.gross).toBe("1.18");
  });

  it("keeps two decimals on every figure, so nothing reaches a document unformatted", () => {
    const t = applyTax("39", IL);
    expect(t.net).toBe("39.00");
    expect(t.gross).toBe("46.02");
  });
});

describe("pricing for a profile", () => {
  it("uses the declared country", async () => {
    taxRate.findFirst.mockResolvedValue({ countryCode: "IL", percent: "18.00", label: 'מע"מ', active: true });
    const t = await taxForProfile("39.00", { billingCountry: "IL" });
    expect(t.gross).toBe("46.02");
    expect(t.tax).toBe("7.02");
  });

  it("refuses when no country was declared", async () => {
    // Defaulting to 0% would charge an Israeli customer no VAT and leave them
    // owing it. One unanswered question is the cheaper failure.
    await expect(taxForProfile("39.00", { billingCountry: null })).rejects.toBeInstanceOf(TaxCountryUndeclared);
    expect(taxRate.findFirst).not.toHaveBeenCalled();
  });

  it("never infers a country from anywhere else", async () => {
    // There is no fallback parameter to pass a tenant default into - the only
    // input is what the customer declared.
    await expect(taxForProfile("39.00", {})).rejects.toBeInstanceOf(TaxCountryUndeclared);
  });
});

describe("display versus charging", () => {
  it("assumes the default jurisdiction when nobody has declared one, and says so", async () => {
    taxRate.findFirst.mockResolvedValue({ countryCode: "IL", percent: "18.00", label: 'מע"מ', active: true });
    const t = await taxForDisplay("39.00");
    expect(t).toMatchObject({ net: "39.00", tax: "7.02", gross: "46.02", assumed: true });
  });

  it("uses a declared country and stops assuming", async () => {
    taxRate.findFirst.mockResolvedValue(null);
    const t = await taxForDisplay("39.00", "US");
    expect(t).toMatchObject({ gross: "39.00", exempt: true, assumed: false });
  });

  it("is a separate function from the charging one, which still refuses", async () => {
    // Showing an assumed total is reasonable. Charging one is not, and the two
    // must not be a flag apart.
    await expect(taxForProfile("39.00", { billingCountry: null })).rejects.toBeInstanceOf(TaxCountryUndeclared);
    taxRate.findFirst.mockResolvedValue({ countryCode: "IL", percent: "18.00", label: 'מע"מ', active: true });
    await expect(taxForDisplay("39.00")).resolves.toMatchObject({ assumed: true });
  });

  it("gives the three numbers a page needs to show a sum", async () => {
    taxRate.findFirst.mockResolvedValue({ countryCode: "IL", percent: "18.00", label: 'מע"מ', active: true });
    const t = await taxForDisplay("97.00", "IL");
    expect(t.net).toBe("97.00");
    expect(t.tax).toBe("17.46");
    expect(t.gross).toBe("114.46");
    expect(t.percent).toBe(18);
    expect(t.label).toBe('מע"מ');
  });
});
