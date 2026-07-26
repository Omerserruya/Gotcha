/**
 * Pricing catalog seeder - plans, volume options, estimation, packages,
 * currency and evaluation templates. Idempotent.
 *
 *   npm run db:seed-pricing        (from packages/shared)
 *
 * EVERY commercial value below is PROVISIONAL SEED CONFIGURATION. It exists so
 * the system has a working catalog to run and verify against; it is not a
 * decision about what GOTCHA charges. All of it is editable from the Sysadmin
 * console without a code change, and live checkout must not be enabled on these
 * numbers.
 *
 * Non-destructive by construction:
 *   • Pre-existing plans (light/pro/business/enterprise/grandfathered) are
 *     re-labelled LEGACY + RETIRED and keep their price, currency, included
 *     credits and entitlements. Subscriptions pointing at them keep working and
 *     are never repointed.
 *   • Pre-existing ILS credit packages are hidden from the customer catalog but
 *     stay `active`, so any AutoPurchasePolicy still referencing one keeps
 *     functioning.
 *   • Nothing here writes to the credit ledger.
 */
import { PrismaClient } from "@prisma/client";
import { FEATURE_CATALOG } from "../src/lib/billing/feature-catalog";
import {
  PLAN_DOMAINS,
  ESTIMATION,
  CURRENCY,
  AUTO_PURCHASE_DEFAULTS,
  PLANS,
  CHAT_OPTIONS,
  VOICE_OPTIONS,
  CREDIT_PACKAGES,
  TRIAL_POC_TEMPLATES,
  LEGACY_PLAN_KEYS,
  LEGACY_PACKAGE_KEYS,
  type PlanSeed,
  type VolumeSeed,
} from "../src/lib/billing/plan-seeds";

const prisma = new PrismaClient();

// ── Seeder ──────────────────────────────────────────────────────────────────

export async function seedPricing(db: PrismaClient): Promise<void> {
  // 1) Feature catalog - the DB mirror of FEATURE_CATALOG, so the Sysadmin
  //    console can list and describe features without importing shared code.
  for (const f of FEATURE_CATALOG) {
    await db.featureDefinition.upsert({
      where: { key: f.key },
      create: {
        key: f.key,
        nameEn: f.nameEn,
        nameHe: f.nameHe,
        descriptionEn: f.descriptionEn,
        descriptionHe: f.descriptionHe,
        category: f.category,
        entitlementType: f.entitlementType,
        defaultValue: f.defaultValue as any,
        enforcementLocations: f.enforcementLocations as any,
        customerVisible: f.customerVisible,
        sysadminOnly: f.sysadminOnly ?? false,
        implemented: f.implemented,
        sortOrder: f.sortOrder,
      },
      update: {
        nameEn: f.nameEn,
        nameHe: f.nameHe,
        descriptionEn: f.descriptionEn,
        descriptionHe: f.descriptionHe,
        category: f.category,
        entitlementType: f.entitlementType,
        defaultValue: f.defaultValue as any,
        enforcementLocations: f.enforcementLocations as any,
        customerVisible: f.customerVisible,
        implemented: f.implemented,
        sortOrder: f.sortOrder,
      },
    });
  }
  console.log(`  • FeatureDefinition seeded (${FEATURE_CATALOG.length} keys)`);

  // 2) Currency configuration - USD canonical, ILS display, ₪5 upward rounding.
  const existingCurrency = await db.pricingCurrencyConfig.findFirst({ where: { active: true } });
  if (!existingCurrency) {
    await db.pricingCurrencyConfig.create({
      data: {
        baseCurrency: CURRENCY,
        displayCurrencies: ["USD", "ILS"],
        ilsRoundingIncrement: 5,
        roundingMode: "UP",
        fxSource: "boi",
        fxRefreshHours: 24,
        fallbackUsdIls: "3.700000",
        // Checkout charges USD; ILS is labelled an estimated conversion until an
        // operator explicitly enables ILS billing.
        chargeInDisplayCurrency: false,
      },
    });
    console.log("  • PricingCurrencyConfig seeded (USD canonical, ILS display, round up to ₪5)");
  }

  // 3) The global public commercial estimate. MANUAL. Never derived from usage.
  const existingEstimation = await db.publicEstimationConfig.findFirst({
    where: { scope: "GLOBAL", active: true },
  });
  if (!existingEstimation) {
    await db.publicEstimationConfig.create({
      data: {
        scope: "GLOBAL",
        version: 1,
        chatCreditsPerEstimatedConversation: ESTIMATION.chatCreditsPerEstimatedConversation.toFixed(4),
        voiceCreditsPerEstimatedCall: ESTIMATION.voiceCreditsPerEstimatedCall.toFixed(4),
        businessDaysPerMonth: ESTIMATION.businessDaysPerMonth,
        internalNote: "Initial commercial assumption. Provisional - not derived from platform usage.",
        createdBy: "seed",
        publishedAt: new Date(),
        publishedBy: "seed",
      },
    });
    console.log("  • PublicEstimationConfig seeded (8 credits/chat, 20 credits/call, 25 business days)");
  }

  // 4) Public plans, version 1.
  for (const p of PLANS) {
    const plan = await db.plan.upsert({
      where: { key_version: { key: p.key, version: 1 } },
      create: {
        key: p.key,
        version: 1,
        name: p.nameEn,
        nameHe: p.nameHe,
        descriptionEn: p.descriptionEn,
        descriptionHe: p.descriptionHe,
        billingInterval: "MONTHLY",
        basePrice: p.monthlyPriceUsd,
        currency: CURRENCY,
        includedAiUnits: p.includedCredits,
        salesOnly: false,
        active: true,
        status: "ACTIVE",
        kind: "PUBLIC",
        sortOrder: p.sortOrder,
        recommended: p.recommended,
        supportLevel: p.supportLevel,
        dataRetentionDays: p.dataRetentionDays,
        autoPurchaseEligible: true,
        creditPackagesEligible: true,
        chatVolumeEnabled: p.chatVolumeEnabled,
        voiceVolumeEnabled: p.voiceVolumeEnabled,
        effectiveFrom: new Date(),
        publishedAt: new Date(),
        publishedBy: "seed",
        internalNote: "Provisional seed pricing. Do not enable live checkout on these values.",
      },
      update: {
        name: p.nameEn,
        nameHe: p.nameHe,
        descriptionEn: p.descriptionEn,
        descriptionHe: p.descriptionHe,
        basePrice: p.monthlyPriceUsd,
        currency: CURRENCY,
        includedAiUnits: p.includedCredits,
        status: "ACTIVE",
        kind: "PUBLIC",
        sortOrder: p.sortOrder,
        recommended: p.recommended,
        supportLevel: p.supportLevel,
        dataRetentionDays: p.dataRetentionDays,
        chatVolumeEnabled: p.chatVolumeEnabled,
        voiceVolumeEnabled: p.voiceVolumeEnabled,
      },
    });

    await seedPlanEntitlements(db, plan.id, p);
    await seedVolumeOptions(db, plan.id, p);
  }
  console.log(`  • Plan seeded (${PLANS.length} public plans, version 1, USD)`);

  // 5) Credit packages, USD.
  for (const c of CREDIT_PACKAGES) {
    await db.creditPackage.upsert({
      where: { key: c.key },
      create: {
        key: c.key,
        name: c.nameEn,
        nameHe: c.nameHe,
        units: c.units,
        price: c.price,
        currency: CURRENCY,
        active: true,
        status: "ACTIVE",
        customerVisible: true,
        expiryPolicy: "NEVER",
        discountLabel: c.discountLabel,
        sortOrder: c.sortOrder,
        internalNote: "Provisional seed pricing.",
      },
      update: {
        name: c.nameEn,
        nameHe: c.nameHe,
        units: c.units,
        price: c.price,
        currency: CURRENCY,
        status: "ACTIVE",
        customerVisible: true,
        discountLabel: c.discountLabel,
        sortOrder: c.sortOrder,
      },
    });
  }
  console.log(`  • CreditPackage seeded (${CREDIT_PACKAGES.length} USD packages)`);

  // 6) Trial / POC templates.
  for (const t of TRIAL_POC_TEMPLATES) {
    await db.trialPocTemplate.upsert({
      where: { key: t.key },
      create: {
        key: t.key,
        nameEn: t.nameEn,
        nameHe: t.nameHe,
        durationDays: t.durationDays,
        creditCap: t.creditCap,
        allFeatures: true,
        autoRenew: false,
        autoPurchaseEnabled: false,
        customerSelfActivate: false,
        restrictions: t.restrictions as any,
        transferRemainingCredits: false,
        bannerKind: t.bannerKind,
        active: true,
      },
      update: {
        nameEn: t.nameEn,
        nameHe: t.nameHe,
        durationDays: t.durationDays,
        creditCap: t.creditCap,
        bannerKind: t.bannerKind,
      },
    });
  }
  console.log(`  • TrialPocTemplate seeded (${TRIAL_POC_TEMPLATES.length} templates)`);

  // 7) Preserve the pre-existing catalog. Re-labelled, never repriced, never
  //    deleted, and never repointed away from by an existing subscription.
  const legacy = await db.plan.updateMany({
    where: { key: { in: LEGACY_PLAN_KEYS } },
    data: { kind: "LEGACY", status: "RETIRED", sortOrder: 900 },
  });
  await db.plan.updateMany({ where: { key: "poc" }, data: { kind: "POC", status: "RETIRED", sortOrder: 950 } });
  console.log(`  • Legacy plans preserved and retired (${legacy.count} rows, prices untouched)`);

  // Legacy ILS packages stay `active` so any AutoPurchasePolicy still pointing
  // at one keeps working; they simply drop out of the customer catalog.
  const legacyPkgs = await db.creditPackage.updateMany({
    where: { key: { in: LEGACY_PACKAGE_KEYS } },
    data: { status: "RETIRED", customerVisible: false },
  });
  console.log(`  • Legacy credit packages hidden but still purchasable by policy (${legacyPkgs.count} rows)`);
}

async function seedPlanEntitlements(db: PrismaClient, planId: string, p: PlanSeed): Promise<void> {
  const rows: Array<{ key: string; valueType: "BOOLEAN" | "COUNTER" | "CONFIG" | "ENUM"; value: unknown }> = [];

  // Coarse permission domains. `isPermissionLicensed()` gates every permission
  // key on its domain, so these must stay present alongside the fine-grained
  // feature keys. Every public plan licenses all nine.
  for (const d of PLAN_DOMAINS) rows.push({ key: d, valueType: "BOOLEAN", value: { bool: true } });

  // Fine-grained capabilities. Explicit false for what the plan does NOT
  // include, so a downgrade actually turns the capability off instead of
  // leaving a stale materialized row enabled.
  const granted = new Set(p.features);
  for (const f of FEATURE_CATALOG) {
    if (f.entitlementType !== "BOOLEAN") continue;
    if (!f.implemented) continue; // never entitle what is not built
    rows.push({ key: f.key, valueType: "BOOLEAN", value: { bool: granted.has(f.key) } });
  }

  for (const [k, v] of Object.entries(p.limits)) rows.push({ key: k, valueType: "COUNTER", value: { count: v } });
  rows.push({ key: "limit:included_ai_units", valueType: "COUNTER", value: { count: p.includedCredits } });
  rows.push({ key: "manager.support", valueType: "ENUM", value: { value: p.supportLevel } });

  // How the base allowance splits across channels for the PUBLIC estimate. Not
  // a ledger fact - the ledger holds one credit balance, undivided.
  rows.push({
    key: "config:credit_split",
    valueType: "CONFIG",
    value: { chat: p.baseChatCredits, voice: p.baseVoiceCredits },
  });
  rows.push({ key: "config:auto_purchase", valueType: "CONFIG", value: AUTO_PURCHASE_DEFAULTS });

  for (const r of rows) {
    await db.planEntitlement.upsert({
      where: { planId_entitlementKey: { planId, entitlementKey: r.key } },
      create: { planId, entitlementKey: r.key, valueType: r.valueType as any, value: r.value as any },
      update: { valueType: r.valueType as any, value: r.value as any },
    });
  }
}

async function seedVolumeOptions(db: PrismaClient, planId: string, p: PlanSeed): Promise<void> {
  const seedSet = async (options: VolumeSeed[], channel: "CHAT" | "VOICE", creditsPerUnit: number) => {
    for (const [i, o] of options.entries()) {
      await db.planVolumeOption.upsert({
        where: { planId_key: { planId, key: o.key } },
        create: {
          planId,
          key: o.key,
          channel,
          dailyVolume: o.dailyVolume,
          businessDaysPerMonth: ESTIMATION.businessDaysPerMonth,
          monthlyVolume: o.dailyVolume * ESTIMATION.businessDaysPerMonth,
          creditsPerUnit: creditsPerUnit.toFixed(4),
          additionalCredits: o.additionalCredits,
          additionalPrice: o.additionalPrice,
          currency: CURRENCY,
          isDefault: Boolean(o.isDefault),
          sortOrder: (i + 1) * 10,
          enabled: true,
          internalNote: "Provisional seed pricing.",
        },
        update: {
          dailyVolume: o.dailyVolume,
          businessDaysPerMonth: ESTIMATION.businessDaysPerMonth,
          monthlyVolume: o.dailyVolume * ESTIMATION.businessDaysPerMonth,
          creditsPerUnit: creditsPerUnit.toFixed(4),
          additionalCredits: o.additionalCredits,
          additionalPrice: o.additionalPrice,
          currency: CURRENCY,
          isDefault: Boolean(o.isDefault),
          sortOrder: (i + 1) * 10,
        },
      });
    }
  };

  // Options are seeded for every plan that could ever offer them, including
  // Foundation - whose selectors are simply disabled. Enabling one later is a
  // toggle on the plan, not a migration.
  await seedSet(CHAT_OPTIONS, "CHAT", ESTIMATION.chatCreditsPerEstimatedConversation);
  if (p.voiceVolumeEnabled) {
    await seedSet(VOICE_OPTIONS, "VOICE", ESTIMATION.voiceCreditsPerEstimatedCall);
  }
}

if (require.main === module) {
  seedPricing(prisma)
    .then(() => prisma.$disconnect())
    .then(() => {
      console.log("✅ Pricing catalog seeded (PROVISIONAL values - do not enable live checkout).");
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Pricing seed failed:", err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
