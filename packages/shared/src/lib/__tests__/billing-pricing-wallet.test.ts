import { describe, it, expect } from "vitest";
import {
  providerCostUsd,
  costToUnits,
  priceUsage,
  type ModelPricing,
  type UnitPricing,
} from "../billing/pricing";
import { crossedThresholds, planConsumption } from "../billing/wallet";

const MINI: ModelPricing = {
  model: "gpt-5-mini",
  inputCostPer1M: 0.25,
  outputCostPer1M: 2.0,
  cachedInputCostPer1M: 0.025,
  categoryMultiplier: 1,
};
const VOICE: ModelPricing = { ...MINI, model: "voice", categoryMultiplier: 2 };
const UNIT: UnitPricing = { unitCostBasisUsd: 0.006, marginFactor: 1 };

describe("billing/pricing: cost-driven math", () => {
  it("computes real provider cost (80/20 split)", () => {
    // 8000 input + 2000 output: 8000*0.25/1e6 + 2000*2.0/1e6 = 0.002 + 0.004 = 0.006
    expect(providerCostUsd(MINI, 8000, 2000)).toBeCloseTo(0.006, 9);
  });

  it("prices cached input tokens at the cached rate", () => {
    // 8000 input of which 4000 cached: 4000*0.25 + 4000*0.025 (per 1M) + 2000*2.0
    const cost = providerCostUsd(MINI, 8000, 2000, 4000);
    const expected = (4000 / 1e6) * 0.25 + (4000 / 1e6) * 0.025 + (2000 / 1e6) * 2.0;
    expect(cost).toBeCloseTo(expected, 9);
  });

  it("falls back cached rate to 50% input when unset", () => {
    const noCached: ModelPricing = { ...MINI, cachedInputCostPer1M: null };
    const cost = providerCostUsd(noCached, 1000, 0, 1000);
    expect(cost).toBeCloseTo((1000 / 1e6) * 0.25 * 0.5, 9);
  });

  it("1 Unit == the unit cost basis (definition)", () => {
    // a call costing exactly unitCostBasisUsd = 1 Unit at margin 1, multiplier 1
    expect(costToUnits(0.006, 1, UNIT)).toBeCloseTo(1, 9);
  });

  it("applies category multiplier (voice 2x)", () => {
    const { unitsConsumed } = priceUsage(VOICE, UNIT, 8000, 2000);
    expect(unitsConsumed).toBeCloseTo(2, 9); // 0.006 cost * 2x / 0.006 basis
  });

  it("margin factor scales Units linearly", () => {
    const margined: UnitPricing = { unitCostBasisUsd: 0.006, marginFactor: 1.5 };
    expect(costToUnits(0.006, 1, margined)).toBeCloseTo(1.5, 9);
  });

  it("guards divide-by-zero basis", () => {
    expect(costToUnits(1, 1, { unitCostBasisUsd: 0, marginFactor: 1 })).toBe(0);
  });
});

describe("billing/wallet: threshold crossing", () => {
  it("detects 80/90/95/100 as consumption rises", () => {
    // allowance 100; consuming from 100→15 remaining crosses 80 only (consumed 85%)
    expect(crossedThresholds(100, 100, 15)).toEqual([80]);
    // 100→8 remaining = 92% consumed → crosses 80 and 90
    expect(crossedThresholds(100, 100, 8)).toEqual([80, 90]);
    // 100→0 crosses all
    expect(crossedThresholds(100, 100, 0)).toEqual([80, 90, 95, 100]);
  });

  it("does not re-fire an already-crossed threshold", () => {
    // already at 85% consumed (15 remaining) → going to 12 remaining (88%) crosses nothing new
    expect(crossedThresholds(100, 15, 12)).toEqual([]);
    // 15 remaining (85%) → 5 remaining (95%) crosses 90 and 95
    expect(crossedThresholds(100, 15, 5)).toEqual([90, 95]);
  });

  it("no thresholds when allowance is zero", () => {
    expect(crossedThresholds(0, 0, 0)).toEqual([]);
  });
});

describe("billing/wallet: FIFO consumption planner", () => {
  const lots = [
    { id: "inc1", bucket: "INCLUDED" as const, unitsRemaining: 50 },
    { id: "pur1", bucket: "PURCHASED" as const, unitsRemaining: 30 },
    { id: "pur2", bucket: "PURCHASED" as const, unitsRemaining: 20 },
  ];

  it("drains INCLUDED before PURCHASED", () => {
    const plan = planConsumption(40, lots);
    expect(plan.debits).toEqual([{ lotId: "inc1", bucket: "INCLUDED", amount: 40 }]);
    expect(plan.shortfall).toBe(0);
  });

  it("spills into PURCHASED oldest-first across lots", () => {
    const plan = planConsumption(95, lots); // 50 inc + 30 pur1 + 15 pur2
    expect(plan.debits).toEqual([
      { lotId: "inc1", bucket: "INCLUDED", amount: 50 },
      { lotId: "pur1", bucket: "PURCHASED", amount: 30 },
      { lotId: "pur2", bucket: "PURCHASED", amount: 15 },
    ]);
    expect(plan.consumed).toBe(95);
    expect(plan.shortfall).toBe(0);
  });

  it("reports shortfall and never over-consumes (no negative)", () => {
    const plan = planConsumption(120, lots); // only 100 available
    expect(plan.consumed).toBe(100);
    expect(plan.shortfall).toBe(20);
    const totalDebited = plan.debits.reduce((s, d) => s + d.amount, 0);
    expect(totalDebited).toBe(100);
  });
});
