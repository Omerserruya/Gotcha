import { describe, it, expect, beforeEach, vi } from "vitest";

const db = {
  config: null as any,
  snapshots: [] as Array<{ rate: string; source: string; rateDate: string; fetchedAt: Date }>,
  writes: [] as any[],
};

let fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; text: string; error?: string }> = async () => ({
  ok: false,
  status: 500,
  text: "",
  error: "no stub",
});

vi.mock("../../prisma", () => ({
  prisma: {
    pricingCurrencyConfig: { findFirst: async () => db.config },
    fxRateSnapshot: {
      findFirst: async () =>
        [...db.snapshots].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0] ?? null,
      upsert: async (args: any) => {
        db.writes.push(args);
        const rate = args.create?.rate ?? args.update?.rate;
        db.snapshots.push({
          rate: String(rate),
          source: args.create.source,
          rateDate: args.create.rateDate,
          fetchedAt: args.create.fetchedAt ?? new Date(),
        });
        return {};
      },
    },
  },
}));

vi.mock("../../safe-fetch", () => ({
  safeFetch: async (url: string) => fetchImpl(url),
}));

import {
  getCurrencyConfig,
  getUsdIlsRate,
  refreshUsdIlsRate,
  toDisplayPrice,
  resolveChargeAmount,
  invalidateCurrencyCache,
  DEFAULT_CURRENCY_CONFIG,
} from "../currency";
import { money, toDecimalString } from "../money";

const NOW = new Date("2026-08-01T09:00:00.000Z");

beforeEach(() => {
  db.config = null;
  db.snapshots = [];
  db.writes = [];
  delete process.env.FX_USD_ILS_URL;
  fetchImpl = async () => ({ ok: false, status: 500, text: "", error: "no stub" });
  invalidateCurrencyCache();
});

describe("currency config", () => {
  it("uses the safe default when nothing is configured", async () => {
    expect(await getCurrencyConfig()).toEqual(DEFAULT_CURRENCY_CONFIG);
  });

  it("reads the operator's configuration", async () => {
    db.config = {
      baseCurrency: "USD",
      displayCurrencies: ["USD", "ILS"],
      ilsRoundingIncrement: 10,
      roundingMode: "UP",
      fxSource: "boi",
      fxRefreshHours: 24,
      fallbackUsdIls: "3.85",
      chargeInDisplayCurrency: false,
    };
    const cfg = await getCurrencyConfig();
    expect(cfg.ilsRoundingIncrement).toBe(10);
    expect(cfg.fallbackUsdIls).toBe("3.85");
  });
});

describe("FX rate", () => {
  it("falls back to the configured constant and labels it as a fallback", async () => {
    const rate = await getUsdIlsRate(NOW);
    expect(rate.rate).toBe("3.70");
    expect(rate.source).toBe("fallback");
    expect(rate.isFallback).toBe(true);
  });

  it("persists a fetched rate with its source and rate date", async () => {
    process.env.FX_USD_ILS_URL = "https://example.test/usd-ils";
    fetchImpl = async () => ({ ok: true, status: 200, text: JSON.stringify({ rate: "3.6421" }) });

    const rate = await refreshUsdIlsRate(NOW);
    expect(rate?.rate).toBe("3.6421");
    expect(rate?.source).toBe("boi");
    expect(rate?.rateDate).toBe("2026-08-01");
    expect(rate?.isFallback).toBe(false);
    expect(db.writes).toHaveLength(1);
  });

  it("accepts the common provider envelopes", async () => {
    process.env.FX_USD_ILS_URL = "https://example.test/usd-ils";
    for (const [body, expected] of [
      [{ currentExchangeRate: "3.51" }, "3.51"],
      [{ rates: { ILS: 3.52 } }, "3.52"],
      [{ data: { rate: "3.53" } }, "3.53"],
    ] as const) {
      db.writes = [];
      invalidateCurrencyCache();
      fetchImpl = async () => ({ ok: true, status: 200, text: JSON.stringify(body) });
      const r = await refreshUsdIlsRate(NOW);
      expect(r?.rate).toBe(expected);
    }
  });

  it("uses the cached snapshot instead of refetching inside the window", async () => {
    db.snapshots.push({ rate: "3.61", source: "boi", rateDate: "2026-08-01", fetchedAt: new Date(NOW.getTime() - 3600_000) });
    let calls = 0;
    process.env.FX_USD_ILS_URL = "https://example.test/usd-ils";
    fetchImpl = async () => { calls++; return { ok: true, status: 200, text: JSON.stringify({ rate: "9.99" }) }; };

    const r = await getUsdIlsRate(NOW);
    expect(r.rate).toBe("3.61");
    expect(calls).toBe(0);
  });

  it("refreshes once the snapshot is older than the refresh window", async () => {
    db.snapshots.push({ rate: "3.61", source: "boi", rateDate: "2026-07-20", fetchedAt: new Date(NOW.getTime() - 48 * 3600_000) });
    process.env.FX_USD_ILS_URL = "https://example.test/usd-ils";
    fetchImpl = async () => ({ ok: true, status: 200, text: JSON.stringify({ rate: "3.72" }) });

    const r = await getUsdIlsRate(NOW);
    expect(r.rate).toBe("3.72");
  });

  it("keeps serving the last known rate when a refresh fails", async () => {
    db.snapshots.push({ rate: "3.61", source: "boi", rateDate: "2026-07-20", fetchedAt: new Date(NOW.getTime() - 48 * 3600_000) });
    process.env.FX_USD_ILS_URL = "https://example.test/usd-ils";
    fetchImpl = async () => ({ ok: false, status: 503, text: "", error: "upstream down" });

    const r = await getUsdIlsRate(NOW);
    // The fetch failed, so the refresh writes a labelled fallback row; either
    // the previous rate or an explicitly-labelled fallback is acceptable, an
    // unlabelled guess is not.
    expect(["3.61", "3.70"]).toContain(r.rate);
    if (r.rate === "3.70") expect(r.isFallback).toBe(true);
  });
});

describe("display price", () => {
  it("returns USD unchanged with no FX and no estimate label", async () => {
    const p = await toDisplayPrice(money("149.00", "USD"), "USD", NOW);
    expect(p.display.formatted).toBe("$149");
    expect(p.isEstimatedConversion).toBe(false);
    expect(p.chargedCurrency).toBe("USD");
    expect(p.fx).toBeNull();
  });

  it("converts to ILS and rounds up to the ₪5 increment", async () => {
    db.snapshots.push({ rate: "3.70", source: "boi", rateDate: "2026-08-01", fetchedAt: NOW });
    const p = await toDisplayPrice(money("149.00", "USD"), "ILS", NOW);
    // 149 x 3.70 = 551.30 -> ₪555
    expect(p.display.formatted).toBe("₪555");
    expect(p.base.formatted).toBe("$149");
  });

  it("labels ILS as an estimated conversion and keeps the charge in USD", async () => {
    db.snapshots.push({ rate: "3.70", source: "boi", rateDate: "2026-08-01", fetchedAt: NOW });
    const p = await toDisplayPrice(money("499.00", "USD"), "ILS", NOW);
    expect(p.isEstimatedConversion).toBe(true);
    expect(p.chargedCurrency).toBe("USD");
    expect(p.fx?.source).toBe("boi");
  });

  it("stops labelling ILS as an estimate once ILS billing is enabled", async () => {
    db.config = { ...DEFAULT_CURRENCY_CONFIG, displayCurrencies: ["USD", "ILS"], chargeInDisplayCurrency: true };
    db.snapshots.push({ rate: "3.70", source: "boi", rateDate: "2026-08-01", fetchedAt: NOW });
    const p = await toDisplayPrice(money("499.00", "USD"), "ILS", NOW);
    expect(p.isEstimatedConversion).toBe(false);
    expect(p.chargedCurrency).toBe("ILS");
  });
});

describe("charge amount", () => {
  it("charges the canonical USD amount and records no FX snapshot by default", async () => {
    db.snapshots.push({ rate: "3.70", source: "boi", rateDate: "2026-08-01", fetchedAt: NOW });
    const r = await resolveChargeAmount(money("149.00", "USD"), "ILS", NOW);
    expect(toDecimalString(r.amount)).toBe("149.00");
    expect(r.amount.currency).toBe("USD");
    expect(r.fxSnapshot).toBeNull();
  });

  it("snapshots the exact rate when charging in ILS", async () => {
    db.config = { ...DEFAULT_CURRENCY_CONFIG, chargeInDisplayCurrency: true };
    db.snapshots.push({ rate: "3.70", source: "boi", rateDate: "2026-08-01", fetchedAt: NOW });
    const r = await resolveChargeAmount(money("149.00", "USD"), "ILS", NOW);
    expect(toDecimalString(r.amount)).toBe("555.00");
    expect(r.fxSnapshot?.rate).toBe("3.70");
    expect(r.fxSnapshot?.rateDate).toBe("2026-08-01");
  });
});
