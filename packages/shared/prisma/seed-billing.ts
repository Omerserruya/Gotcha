/**
 * Billing catalog seeder - pricing engine + plan/credit catalog. Idempotent.
 *
 *   npm run db:seed-billing        (from packages/shared)
 *
 * Seeds:
 *   • BillableModel       - cost-driven per-model provider rates + multipliers
 *                           (incl. gpt-5 family, fixing the stale AI_MODEL_PRICING).
 *   • UnitPricingConfig   - the cost→Unit conversion (1 Unit = unitCostBasisUsd).
 *   • Plan + PlanEntitlement - Light/Pro/Business/Enterprise + grandfathered.
 *   • CreditPackage       - purchasable AI-Unit packs.
 *
 * Pricing/margins/limits are DATA. Re-run after editing the tables below.
 */
import { PrismaClient } from "@prisma/client";
import { PLAN_PRESETS, PLAN_DOMAINS } from "../src/lib/plans";

const prisma = new PrismaClient();

// USD per 1M tokens. gpt-5 family + embeddings + voice/deep-research surcharges.
const MODELS: Array<{
  model: string;
  kind: string;
  input: number;
  output: number;
  cachedInput?: number;
  multiplier?: number;
}> = [
  { model: "gpt-5-mini", kind: "CHAT", input: 0.25, output: 2.0, cachedInput: 0.025, multiplier: 1 },
  { model: "gpt-5", kind: "CHAT", input: 1.25, output: 10.0, cachedInput: 0.125, multiplier: 1 },
  { model: "gpt-5-nano", kind: "CHAT", input: 0.05, output: 0.4, cachedInput: 0.005, multiplier: 1 },
  { model: "gpt-4o-mini", kind: "CHAT", input: 0.15, output: 0.6, cachedInput: 0.075, multiplier: 1 },
  { model: "gpt-4o", kind: "CHAT", input: 2.5, output: 10.0, cachedInput: 1.25, multiplier: 1 },
  { model: "text-embedding-3-small", kind: "EMBEDDING", input: 0.02, output: 0, multiplier: 1 },
  { model: "text-embedding-3-large", kind: "EMBEDDING", input: 0.13, output: 0, multiplier: 1 },
  // Modality surcharges (commercial), applied on top of real cost.
  { model: "voice", kind: "VOICE", input: 0.25, output: 2.0, cachedInput: 0.025, multiplier: 2 },
  { model: "deep-research", kind: "DEEP_RESEARCH", input: 1.25, output: 10.0, cachedInput: 0.125, multiplier: 10 },
];

// Plan commercial terms (ILS). Domains/features come from PLAN_PRESETS so the
// in-code packaging and the DB catalog never drift.
const PLANS: Array<{
  key: keyof typeof PLAN_PRESETS;
  basePrice: number | null;
  includedAiUnits: number;
  salesOnly: boolean;
  limits: Record<string, number>;
}> = [
  { key: "light", basePrice: 149, includedAiUnits: 500, salesOnly: false, limits: { "limit:users": 3, "limit:ai_employees": 0, "limit:channels": 2, "limit:storage_gb": 5 } },
  { key: "pro", basePrice: 499, includedAiUnits: 2500, salesOnly: false, limits: { "limit:users": 10, "limit:ai_employees": 2, "limit:channels": 6, "limit:storage_gb": 25 } },
  { key: "business", basePrice: 1499, includedAiUnits: 8000, salesOnly: false, limits: { "limit:users": 30, "limit:ai_employees": 6, "limit:channels": 20, "limit:storage_gb": 100 } },
  { key: "enterprise", basePrice: null, includedAiUnits: 25000, salesOnly: true, limits: { "limit:users": 200, "limit:ai_employees": 25, "limit:channels": 100, "limit:storage_gb": 500 } },
  { key: "grandfathered", basePrice: null, includedAiUnits: 0, salesOnly: true, limits: {} },
];

const CREDIT_PACKAGES: Array<{ key: string; name: string; units: number; price: number }> = [
  { key: "units_1000", name: "1,000 AI Units", units: 1000, price: 199 },
  { key: "units_5000", name: "5,000 AI Units", units: 5000, price: 899 },
  { key: "units_20000", name: "20,000 AI Units", units: 20000, price: 2999 },
];

async function seedBilling(db: PrismaClient): Promise<void> {
  // 1) Unit pricing: 1 Unit = cost of 10k gpt-5-mini tokens @ 80/20 ≈ $0.006.
  const existingUnit = await db.unitPricingConfig.findFirst({ where: { active: true } });
  if (!existingUnit) {
    await db.unitPricingConfig.create({
      data: { unitCostBasisUsd: "0.00600000", marginFactor: "1.0", currency: "USD" },
    });
    console.log("  • UnitPricingConfig seeded (1 Unit = $0.006 provider cost)");
  }

  // 2) Billable models (newest-active wins; upsert by latest row per model).
  for (const m of MODELS) {
    const exists = await db.billableModel.findFirst({ where: { model: m.model, active: true } });
    if (exists) {
      await db.billableModel.update({
        where: { id: exists.id },
        data: {
          kind: m.kind,
          inputCostPer1M: m.input.toFixed(6),
          outputCostPer1M: m.output.toFixed(6),
          cachedInputCostPer1M: m.cachedInput != null ? m.cachedInput.toFixed(6) : null,
          categoryMultiplier: (m.multiplier ?? 1).toFixed(4),
        },
      });
    } else {
      await db.billableModel.create({
        data: {
          model: m.model,
          provider: "openai",
          kind: m.kind,
          inputCostPer1M: m.input.toFixed(6),
          outputCostPer1M: m.output.toFixed(6),
          cachedInputCostPer1M: m.cachedInput != null ? m.cachedInput.toFixed(6) : null,
          categoryMultiplier: (m.multiplier ?? 1).toFixed(4),
        },
      });
    }
  }
  console.log(`  • BillableModel seeded (${MODELS.length} models incl. gpt-5 family)`);

  // 3) Plans + entitlements (domains as BOOLEAN, limits as COUNTER, units as COUNTER).
  for (const p of PLANS) {
    const preset = PLAN_PRESETS[p.key];
    const plan = await db.plan.upsert({
      where: { key_version: { key: p.key, version: 1 } },
      create: {
        key: p.key,
        name: preset.name,
        version: 1,
        billingInterval: "MONTHLY",
        basePrice: p.basePrice != null ? p.basePrice.toFixed(2) : null,
        currency: "ILS",
        includedAiUnits: p.includedAiUnits,
        salesOnly: p.salesOnly,
      },
      update: {
        name: preset.name,
        basePrice: p.basePrice != null ? p.basePrice.toFixed(2) : null,
        includedAiUnits: p.includedAiUnits,
        salesOnly: p.salesOnly,
      },
    });

    const entitlements: Array<{ key: string; valueType: "BOOLEAN" | "COUNTER"; value: any }> = [];
    // Feature domains → BOOLEAN (true if in plan).
    const enabledDomains = new Set(preset.domains);
    for (const d of PLAN_DOMAINS) entitlements.push({ key: d, valueType: "BOOLEAN", value: { bool: enabledDomains.has(d) } });
    // Numeric limits → COUNTER.
    for (const [k, v] of Object.entries(p.limits)) entitlements.push({ key: k, valueType: "COUNTER", value: { count: v } });
    // Included monthly units as a COUNTER for visibility.
    entitlements.push({ key: "limit:included_ai_units", valueType: "COUNTER", value: { count: p.includedAiUnits } });

    for (const e of entitlements) {
      await db.planEntitlement.upsert({
        where: { planId_entitlementKey: { planId: plan.id, entitlementKey: e.key } },
        create: { planId: plan.id, entitlementKey: e.key, valueType: e.valueType, value: e.value },
        update: { valueType: e.valueType, value: e.value },
      });
    }
  }
  console.log(`  • Plan + PlanEntitlement seeded (${PLANS.length} plans)`);

  // 4) Credit packages.
  for (const c of CREDIT_PACKAGES) {
    await db.creditPackage.upsert({
      where: { key: c.key },
      create: { key: c.key, name: c.name, units: c.units, price: c.price.toFixed(2), currency: "ILS" },
      update: { name: c.name, units: c.units, price: c.price.toFixed(2) },
    });
  }
  console.log(`  • CreditPackage seeded (${CREDIT_PACKAGES.length} packages)`);
}

export { seedBilling };

// Allow standalone execution.
if (require.main === module) {
  seedBilling(prisma)
    .then(() => prisma.$disconnect())
    .then(() => {
      console.log("✅ Billing catalog seeded.");
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Billing seed failed:", err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
