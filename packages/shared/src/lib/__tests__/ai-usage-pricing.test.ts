import { describe, it, expect } from "vitest";
import { AI_MODEL_PRICING, resolveModelPricing, estimateAICost, computeAICostUsd } from "../ai-usage";

describe("resolveModelPricing", () => {
  it("resolves the platform default model exactly", () => {
    expect(resolveModelPricing("gpt-5-mini")).toEqual(AI_MODEL_PRICING["gpt-5-mini"]);
  });

  it("resolves dated model ids by longest prefix", () => {
    expect(resolveModelPricing("gpt-5-mini-2025-08-07")).toEqual(AI_MODEL_PRICING["gpt-5-mini"]);
    // "gpt-5-nano-x" must match gpt-5-nano, not the shorter gpt-5 prefix.
    expect(resolveModelPricing("gpt-5-nano-preview")).toEqual(AI_MODEL_PRICING["gpt-5-nano"]);
  });

  it("falls back to gpt-5-mini rates for unknown models and null", () => {
    expect(resolveModelPricing("claude-fable-5")).toEqual(AI_MODEL_PRICING["gpt-5-mini"]);
    expect(resolveModelPricing(null)).toEqual(AI_MODEL_PRICING["gpt-5-mini"]);
  });
});

describe("estimateAICost", () => {
  it("prices gpt-5-mini at its real rates (the historical 3.3x undercount bug)", () => {
    // 1M in + 1M out on gpt-5-mini = $0.25 + $2.00
    expect(estimateAICost(1_000_000, 1_000_000, "gpt-5-mini")).toBeCloseTo(2.25, 6);
  });

  it("keeps legacy model rates intact", () => {
    expect(estimateAICost(1_000_000, 1_000_000, "gpt-4o-mini")).toBeCloseTo(0.75, 6);
  });
});

describe("computeAICostUsd", () => {
  it("bills cached prompt tokens at the model's cached rate (90% off for gpt-5 family)", () => {
    const cost = computeAICostUsd({
      model: "gpt-5-mini",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.025, 6);
  });

  it("splits uncached/cached prompt tokens", () => {
    const cost = computeAICostUsd({
      model: "gpt-5-mini",
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      cachedPromptTokens: 400_000,
    });
    // 600k uncached * 0.25 + 400k cached * 0.025 + 500k out * 2.00 (per 1M)
    expect(cost).toBeCloseTo(0.6 * 0.25 + 0.4 * 0.025 + 0.5 * 2.0, 6);
  });

  it("falls back to 50% of prompt rate for models without a cached rate", () => {
    const cost = computeAICostUsd({
      model: "gpt-4-turbo",
      promptTokens: 1_000_000,
      cachedPromptTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5.0, 6);
  });

  it("clamps cached tokens to promptTokens and negatives to zero", () => {
    const cost = computeAICostUsd({
      model: "gpt-5-mini",
      promptTokens: 100,
      cachedPromptTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo((100 / 1_000_000) * 0.025, 12);
  });
});
