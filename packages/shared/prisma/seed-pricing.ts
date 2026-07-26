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
import { PLAN_DOMAINS } from "../src/lib/plans";

const prisma = new PrismaClient();

// ── Provisional commercial assumptions ──────────────────────────────────────

const ESTIMATION = {
  chatCreditsPerEstimatedConversation: 8,
  voiceCreditsPerEstimatedCall: 20,
  businessDaysPerMonth: 25,
};

const CURRENCY = "USD";

/** Auto-purchase defaults, attached per plan so a plan can override them. */
const AUTO_PURCHASE_DEFAULTS = {
  pricePerCredit: "0.03",
  incrementCredits: 1000,
  defaultMonthlySpendLimit: "500.00",
  warningThresholdPct: 80,
  thresholdPct: 10,
};

// Capabilities every public plan includes.
const CORE_FEATURES = [
  "communication.omnichannel",
  "communication.broadcasts",
  "communication.automations",
  "communication.social_engagement",
  "communication.crm_summaries",
  "ai.department_router",
  "ai.command_center",
  "ai.knowledge_base",
  "ai.customer_360",
  "ai.sentiment_analysis",
  "ai.usage_tracking",
  "ai.action_approval",
  "manager.integrations",
  "manager.dashboard",
  "manager.representative_tracking",
  "manager.data_retention",
];

const WORKFORCE_FEATURES = ["ai.employee", "ai.copilot"];
const VOICE_FEATURES = ["voice.call_pilot", "voice.call_summary", "voice.inbound", "voice.outbound"];

interface PlanSeed {
  key: string;
  nameEn: string;
  nameHe: string;
  descriptionEn: string;
  descriptionHe: string;
  /** Provisional public price, USD per month. */
  monthlyPriceUsd: string;
  /** Base recurring credits. For AI Voice this covers chat AND voice. */
  includedCredits: number;
  /** How the base allowance splits across channels, for the public estimate. */
  baseChatCredits: number;
  baseVoiceCredits: number;
  features: string[];
  limits: Record<string, number>;
  supportLevel: string;
  dataRetentionDays: number;
  chatVolumeEnabled: boolean;
  voiceVolumeEnabled: boolean;
  recommended: boolean;
  sortOrder: number;
}

const PLANS: PlanSeed[] = [
  {
    key: "foundation",
    nameEn: "Foundation",
    nameHe: "בסיס",
    descriptionEn: "Every conversation in one place, with AI that understands your business.",
    descriptionHe: "כל השיחות במקום אחד, עם AI שמבין את העסק שלך.",
    monthlyPriceUsd: "149.00",
    includedCredits: 2000,
    baseChatCredits: 2000,
    baseVoiceCredits: 0,
    features: CORE_FEATURES,
    limits: {
      "limit:users": 5,
      "limit:ai_employees": 0,
      "limit:channels": 3,
      "limit:departments": 3,
      "limit:knowledge_sources": 25,
      "limit:workflows": 10,
      "limit:voice_channels": 0,
      "limit:storage_gb": 25,
      "limit:data_retention_days": 180,
    },
    supportLevel: "standard",
    dataRetentionDays: 180,
    // Deliberately OFF at launch. Turning it on later is a data change - the
    // plan already carries the flag and the option rows are seeded below.
    chatVolumeEnabled: false,
    voiceVolumeEnabled: false,
    recommended: false,
    sortOrder: 10,
  },
  {
    key: "ai_workforce",
    nameEn: "AI Workforce",
    nameHe: "כוח עבודה AI",
    descriptionEn: "Add AI employees that handle conversations, and a copilot for your team.",
    descriptionHe: "הוספת עובדי AI שמטפלים בשיחות, וקופיילוט לצוות שלך.",
    monthlyPriceUsd: "499.00",
    includedCredits: 2000,
    baseChatCredits: 2000,
    baseVoiceCredits: 0,
    features: [...CORE_FEATURES, ...WORKFORCE_FEATURES],
    limits: {
      "limit:users": 15,
      "limit:ai_employees": 5,
      "limit:channels": 8,
      "limit:departments": 8,
      "limit:knowledge_sources": 50,
      "limit:workflows": 30,
      "limit:voice_channels": 0,
      "limit:storage_gb": 100,
      "limit:data_retention_days": 365,
    },
    supportLevel: "priority",
    dataRetentionDays: 365,
    chatVolumeEnabled: true,
    voiceVolumeEnabled: false,
    recommended: true,
    sortOrder: 20,
  },
  {
    key: "ai_voice",
    nameEn: "AI Voice",
    nameHe: "קול AI",
    descriptionEn: "Everything in AI Workforce, on the phone as well as in chat.",
    descriptionHe: "כל מה שיש ב-AI Workforce, גם בטלפון וגם בצ'אט.",
    monthlyPriceUsd: "1499.00",
    // 2,000 chat credits (10 chats/day) + 5,000 voice credits (10 calls/day).
    // The base allowance is the SUM, because 2,000 credits alone cannot fund
    // both under the configured public ratios - and we do not claim it can.
    includedCredits: 7000,
    baseChatCredits: 2000,
    baseVoiceCredits: 5000,
    features: [...CORE_FEATURES, ...WORKFORCE_FEATURES, ...VOICE_FEATURES],
    limits: {
      "limit:users": 40,
      "limit:ai_employees": 15,
      "limit:channels": 20,
      "limit:departments": 20,
      "limit:knowledge_sources": 200,
      "limit:workflows": 100,
      "limit:voice_channels": 5,
      "limit:storage_gb": 500,
      "limit:data_retention_days": 730,
    },
    supportLevel: "dedicated",
    dataRetentionDays: 730,
    chatVolumeEnabled: true,
    voiceVolumeEnabled: true,
    recommended: false,
    sortOrder: 30,
  },
];

// ── Volume options ──────────────────────────────────────────────────────────
// `additionalCredits` is what the option ADDS to the plan's base allowance.
// `additionalPrice` is a fixed commercial price, not a derived formula.

interface VolumeSeed {
  key: string;
  dailyVolume: number;
  additionalCredits: number;
  additionalPrice: string;
  isDefault?: boolean;
}

const CHAT_OPTIONS: VolumeSeed[] = [
  { key: "chat_10", dailyVolume: 10, additionalCredits: 0, additionalPrice: "0.00", isDefault: true },
  { key: "chat_25", dailyVolume: 25, additionalCredits: 3000, additionalPrice: "79.00" },
  { key: "chat_50", dailyVolume: 50, additionalCredits: 8000, additionalPrice: "179.00" },
  { key: "chat_100", dailyVolume: 100, additionalCredits: 18000, additionalPrice: "349.00" },
  { key: "chat_200", dailyVolume: 200, additionalCredits: 38000, additionalPrice: "649.00" },
];

const VOICE_OPTIONS: VolumeSeed[] = [
  { key: "voice_10", dailyVolume: 10, additionalCredits: 0, additionalPrice: "0.00", isDefault: true },
  { key: "voice_25", dailyVolume: 25, additionalCredits: 7500, additionalPrice: "249.00" },
  { key: "voice_50", dailyVolume: 50, additionalCredits: 20000, additionalPrice: "599.00" },
  { key: "voice_100", dailyVolume: 100, additionalCredits: 45000, additionalPrice: "1199.00" },
  { key: "voice_200", dailyVolume: 200, additionalCredits: 95000, additionalPrice: "2299.00" },
];

// ── Credit packages (USD) ───────────────────────────────────────────────────

const CREDIT_PACKAGES = [
  { key: "credits_1000", nameEn: "1,000 credits", nameHe: "1,000 קרדיטים", units: 1000, price: "25.00", discountLabel: null, sortOrder: 10 },
  { key: "credits_5000", nameEn: "5,000 credits", nameHe: "5,000 קרדיטים", units: 5000, price: "110.00", discountLabel: "save 12%", sortOrder: 20 },
  { key: "credits_20000", nameEn: "20,000 credits", nameHe: "20,000 קרדיטים", units: 20000, price: "399.00", discountLabel: "save 20%", sortOrder: 30 },
  { key: "credits_50000", nameEn: "50,000 credits", nameHe: "50,000 קרדיטים", units: 50000, price: "899.00", discountLabel: "save 28%", sortOrder: 40 },
];

// ── Evaluation templates ────────────────────────────────────────────────────

const TRIAL_POC_TEMPLATES = [
  {
    key: "trial",
    nameEn: "Trial",
    nameHe: "תקופת ניסיון",
    durationDays: 14,
    creditCap: 5000,
    bannerKind: "TRIAL",
    restrictions: null as unknown,
  },
  {
    key: "poc",
    nameEn: "POC / Pilot",
    nameHe: "פיילוט",
    durationDays: 30,
    creditCap: 10000,
    bannerKind: "POC",
    // Operators may restrict which providers a pilot tenant can reach.
    restrictions: { providers: [] as string[] },
  },
];

/** Legacy plan keys preserved for grandfathering. Never deleted, never repriced. */
const LEGACY_PLAN_KEYS = ["light", "pro", "business", "enterprise", "grandfathered"];
const LEGACY_PACKAGE_KEYS = ["units_1000", "units_5000", "units_20000"];

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

export { PLANS as PRICING_PLAN_SEEDS, CHAT_OPTIONS, VOICE_OPTIONS, CREDIT_PACKAGES, ESTIMATION };

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
