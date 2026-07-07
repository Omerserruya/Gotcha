/**
 * AI-Unit pricing engine — COST-DRIVEN, not token-driven.
 *
 * AI Units are an abstraction over real provider COST. The runtime reports
 * `model + inputTokens + outputTokens`; we compute the real provider cost from
 * the `BillableModel` table, then convert that cost into Units via
 * `UnitPricingConfig`:
 *
 *   providerCostUsd = inToks/1M·inputRate + outToks/1M·outputRate + cachedToks/1M·cachedRate
 *   unitsConsumed   = providerCostUsd · categoryMultiplier · marginFactor / unitCostBasisUsd
 *
 * Adding a model, changing provider prices, or adjusting commercial margin is a
 * DATA change (BillableModel / UnitPricingConfig rows) — never a code change.
 *
 * The pure functions below are DB-free and unit-tested. `loadModelPricing` /
 * `loadUnitPricing` read the newest active config with a short in-process cache.
 */
import { prisma } from "../prisma";

export interface ModelPricing {
  model: string;
  /** USD per 1M input (prompt) tokens. */
  inputCostPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputCostPer1M: number;
  /** USD per 1M cached input tokens. Falls back to 50% of input when null. */
  cachedInputCostPer1M?: number | null;
  /** Commercial surcharge for the modality (voice 2×, deep-research 10×…). */
  categoryMultiplier: number;
}

export interface UnitPricing {
  /** Real provider cost (USD) that equals exactly 1 AI Unit. */
  unitCostBasisUsd: number;
  /** Scales cost→Units to set commercial margin. */
  marginFactor: number;
}

/**
 * Safe fallbacks used ONLY when the DB has no pricing rows yet (e.g. observe
 * mode before seeding). Mirrors today's gpt-5-mini default at ~1 Unit / 10k
 * tokens (80/20). Keep conservative so we never under-count cost.
 */
export const FALLBACK_MODEL_PRICING: ModelPricing = {
  model: "__fallback__",
  inputCostPer1M: 0.25,
  outputCostPer1M: 2.0,
  cachedInputCostPer1M: 0.025,
  categoryMultiplier: 1,
};

export const FALLBACK_UNIT_PRICING: UnitPricing = {
  // cost of 10k gpt-5-mini tokens @ 80/20 ≈ 8k·0.25/1M + 2k·2.0/1M = 0.002 + 0.004 = 0.006
  unitCostBasisUsd: 0.006,
  marginFactor: 1,
};

// ── Pure math (DB-free, unit-tested) ───────────────────────────────────────

/** Real provider cost in USD for a single model call. */
export function providerCostUsd(
  p: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const cachedRate = p.cachedInputCostPer1M ?? p.inputCostPer1M * 0.5;
  return (
    (uncachedInput / 1_000_000) * p.inputCostPer1M +
    (cachedInputTokens / 1_000_000) * cachedRate +
    (outputTokens / 1_000_000) * p.outputCostPer1M
  );
}

/** Convert a provider cost into AI Units (commercial abstraction). */
export function costToUnits(
  costUsd: number,
  categoryMultiplier: number,
  unit: UnitPricing,
): number {
  if (unit.unitCostBasisUsd <= 0) return 0;
  return (costUsd * categoryMultiplier * unit.marginFactor) / unit.unitCostBasisUsd;
}

/** One-shot: tokens → { providerCostUsd, unitsConsumed }. */
export function priceUsage(
  model: ModelPricing,
  unit: UnitPricing,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): { providerCostUsd: number; unitsConsumed: number } {
  const cost = providerCostUsd(model, inputTokens, outputTokens, cachedInputTokens);
  return {
    providerCostUsd: cost,
    unitsConsumed: costToUnits(cost, model.categoryMultiplier, unit),
  };
}

// ── DB-backed config loaders (short in-process cache) ───────────────────────

const CACHE_TTL_MS = 30_000;
let modelCache: { at: number; map: Map<string, ModelPricing> } | null = null;
let unitCache: { at: number; value: UnitPricing } | null = null;

function dec(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  // Prisma Decimal | string | number
  const n = typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function loadModelMap(): Promise<Map<string, ModelPricing>> {
  if (modelCache && Date.now() - modelCache.at < CACHE_TTL_MS) return modelCache.map;
  const map = new Map<string, ModelPricing>();
  try {
    const rows = await prisma.billableModel.findMany({
      where: { active: true, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: "desc" },
    });
    // First (newest) row per model wins.
    for (const r of rows) {
      if (map.has(r.model)) continue;
      map.set(r.model, {
        model: r.model,
        inputCostPer1M: dec(r.inputCostPer1M),
        outputCostPer1M: dec(r.outputCostPer1M),
        cachedInputCostPer1M: r.cachedInputCostPer1M == null ? null : dec(r.cachedInputCostPer1M),
        categoryMultiplier: dec(r.categoryMultiplier, 1),
      });
    }
  } catch (err: any) {
    console.error("[billing/pricing] loadModelMap failed:", err?.message ?? err);
  }
  modelCache = { at: Date.now(), map };
  return map;
}

/** Resolve pricing for a model, falling back to a safe default. */
export async function loadModelPricing(model?: string | null): Promise<ModelPricing> {
  const map = await loadModelMap();
  if (model && map.has(model)) return map.get(model)!;
  return { ...FALLBACK_MODEL_PRICING, model: model ?? FALLBACK_MODEL_PRICING.model };
}

export async function loadUnitPricing(): Promise<UnitPricing> {
  if (unitCache && Date.now() - unitCache.at < CACHE_TTL_MS) return unitCache.value;
  let value = FALLBACK_UNIT_PRICING;
  try {
    const row = await prisma.unitPricingConfig.findFirst({
      where: { active: true, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: "desc" },
    });
    if (row) value = { unitCostBasisUsd: dec(row.unitCostBasisUsd, FALLBACK_UNIT_PRICING.unitCostBasisUsd), marginFactor: dec(row.marginFactor, 1) };
  } catch (err: any) {
    console.error("[billing/pricing] loadUnitPricing failed:", err?.message ?? err);
  }
  unitCache = { at: Date.now(), value };
  return value;
}

export function invalidatePricingCache(): void {
  modelCache = null;
  unitCache = null;
}

/** DB-backed convenience: price a real usage event end-to-end. */
export async function priceUsageFromDb(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): Promise<{ providerCostUsd: number; unitsConsumed: number; pricing: ModelPricing }> {
  const [pricing, unit] = await Promise.all([loadModelPricing(model), loadUnitPricing()]);
  const { providerCostUsd, unitsConsumed } = priceUsage(pricing, unit, inputTokens, outputTokens, cachedInputTokens);
  return { providerCostUsd, unitsConsumed, pricing };
}
