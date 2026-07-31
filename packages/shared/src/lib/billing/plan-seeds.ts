/**
 * Provisional pricing seed constants.
 *
 * Every value here is PROVISIONAL SEED CONFIGURATION. It exists so the system
 * has a working catalog to run and verify against; it is not a decision about
 * what GOTCHA charges. All of it is editable from the Sysadmin console without a
 * code change, and live checkout must not be enabled on these numbers.
 *
 * Lives under `src/` (not `prisma/`) so both the seeder and the test suite can
 * import it without crossing the package's rootDir.
 */
import { FEATURE_CATALOG } from "./feature-catalog";
import { PLAN_DOMAINS } from "../plans";

export { PLAN_DOMAINS };

// ── Provisional commercial assumptions ──────────────────────────────────────

export const ESTIMATION = {
  chatCreditsPerEstimatedConversation: 8,
  voiceCreditsPerEstimatedCall: 20,
  businessDaysPerMonth: 25,
};

export const CURRENCY = "USD";

/** Auto-purchase defaults, attached per plan so a plan can override them. */
export const AUTO_PURCHASE_DEFAULTS = {
  pricePerCredit: "0.03",
  incrementCredits: 1000,
  defaultMonthlySpendLimit: "500.00",
  warningThresholdPct: 80,
  thresholdPct: 10,
};

// Capabilities every public plan includes.
export const CORE_FEATURES = [
  // The two Shopify commerce capabilities join CORE rather than a paid tier.
  // That is not a pricing decision — it PRESERVES today's behaviour. Both were
  // gated only by the legacy Feature enum, whose metadata default is
  // `defaultEnabled: true`, so every tenant already has them. Putting them on a
  // narrower tier here would silently REMOVE a capability that customers
  // currently use. Moving them to a paid tier is a commercial decision to make
  // deliberately, with migration, not as a side effect of adding a key.
  //
  // commerce.auto_buy is deliberately ABSENT: it spends a customer's money and
  // its legacy default was already false, so granting it here would be a
  // loosening, not a preservation.
  "commerce.shopify_live_chat",
  "commerce.shopify_product_messaging",
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

export const WORKFORCE_FEATURES = ["ai.employee", "ai.copilot"];
export const VOICE_FEATURES = ["voice.call_pilot", "voice.call_summary", "voice.inbound", "voice.outbound"];

export interface PlanSeed {
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

export const PLANS: PlanSeed[] = [
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
    descriptionHe: "כל היכולות של כוח עבודה AI, גם בטלפון וגם בצ'אט.",
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

export interface VolumeSeed {
  key: string;
  dailyVolume: number;
  additionalCredits: number;
  additionalPrice: string;
  isDefault?: boolean;
}

export const CHAT_OPTIONS: VolumeSeed[] = [
  { key: "chat_10", dailyVolume: 10, additionalCredits: 0, additionalPrice: "0.00", isDefault: true },
  { key: "chat_25", dailyVolume: 25, additionalCredits: 3000, additionalPrice: "79.00" },
  { key: "chat_50", dailyVolume: 50, additionalCredits: 8000, additionalPrice: "179.00" },
  { key: "chat_100", dailyVolume: 100, additionalCredits: 18000, additionalPrice: "349.00" },
  { key: "chat_200", dailyVolume: 200, additionalCredits: 38000, additionalPrice: "649.00" },
];

export const VOICE_OPTIONS: VolumeSeed[] = [
  { key: "voice_10", dailyVolume: 10, additionalCredits: 0, additionalPrice: "0.00", isDefault: true },
  { key: "voice_25", dailyVolume: 25, additionalCredits: 7500, additionalPrice: "249.00" },
  { key: "voice_50", dailyVolume: 50, additionalCredits: 20000, additionalPrice: "599.00" },
  { key: "voice_100", dailyVolume: 100, additionalCredits: 45000, additionalPrice: "1199.00" },
  { key: "voice_200", dailyVolume: 200, additionalCredits: 95000, additionalPrice: "2299.00" },
];

// ── Credit packages (USD) ───────────────────────────────────────────────────

export const CREDIT_PACKAGES = [
  { key: "credits_1000", nameEn: "1,000 credits", nameHe: "1,000 קרדיטים", units: 1000, price: "25.00", discountLabel: null, sortOrder: 10 },
  { key: "credits_5000", nameEn: "5,000 credits", nameHe: "5,000 קרדיטים", units: 5000, price: "110.00", discountLabel: "save 12%", sortOrder: 20 },
  { key: "credits_20000", nameEn: "20,000 credits", nameHe: "20,000 קרדיטים", units: 20000, price: "399.00", discountLabel: "save 20%", sortOrder: 30 },
  { key: "credits_50000", nameEn: "50,000 credits", nameHe: "50,000 קרדיטים", units: 50000, price: "899.00", discountLabel: "save 28%", sortOrder: 40 },
];

// ── Evaluation templates ────────────────────────────────────────────────────

export const TRIAL_POC_TEMPLATES = [
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
export const LEGACY_PLAN_KEYS = ["light", "pro", "business", "enterprise", "grandfathered"];
export const LEGACY_PACKAGE_KEYS = ["units_1000", "units_5000", "units_20000"];

