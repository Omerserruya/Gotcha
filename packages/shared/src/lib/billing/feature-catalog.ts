/**
 * Canonical feature catalog - the sellable capability surface.
 *
 * Every entitlement is addressed by a STABLE key (`ai.employee`), never by a
 * translated label. Plans entitle a subset of these keys; the entitlement
 * resolver reads the catalog to know each key's type, default value and
 * customer visibility; `materializeEntitlements()` writes the BOOLEAN keys into
 * `TenantFeature`, which is the read cache the permission resolver already
 * consumes.
 *
 * Relationship to the pre-existing packaging layer
 * ------------------------------------------------
 * `plans.ts` packages the nine coarse PERMISSION DOMAINS (`conversation`, `ai`,
 * `settings`, …). `isPermissionLicensed()` gates every permission key on its
 * domain, so those rows must keep existing. This catalog is the FINE-GRAINED
 * layer that sits on top: a tenant can have the `ai` domain licensed and still
 * not be entitled to `ai.employee`. Both live in the same `TenantFeature` table
 * because it is a generic `key → bool` store.
 *
 * `implemented: false` is a hard commercial guard. A capability that is not
 * built cannot be entitled, cannot be attached to a plan, and never renders on a
 * pricing page - regardless of what a plan configuration asks for.
 *
 * Relationship to `lib/features.ts`
 * ---------------------------------
 * That file is the ACCESS axis (may this actor use it: role grants, per-user
 * overrides, agent defaults). This one is the COMMERCIAL axis (did this tenant
 * buy it). They are layered - `requireEntitlement` then `requireFeature` - and
 * must not be merged: collapsing them makes every purchased capability
 * available to every user in the tenant. See the header of `lib/features.ts`.
 *
 * `enforcementLocations` is CHECKED, not decorative:
 * `__tests__/enforcement-contract.test.ts` fails if a capability claims
 * enforcement that no code references. Either gate the path or drop the claim.
 */

import type { EntitlementValueType } from "@prisma/client";
// The OTHER key namespace: the license keys a plan sells. Imported rather than
// re-listed so a new permission domain cannot appear in the product and be
// treated here as an unknown, unsellable key.
import { ALL_LICENSE_KEYS } from "../permission-catalog";

export type FeatureCategory = "COMMUNICATION" | "AI" | "VOICE" | "MANAGEMENT";

export interface FeatureDef {
  key: string;
  nameEn: string;
  nameHe: string;
  descriptionEn: string;
  descriptionHe: string;
  category: FeatureCategory;
  entitlementType: EntitlementValueType;
  /** Applied when neither a plan nor an override supplies a value. */
  defaultValue: unknown;
  /** Where this key is enforced server-side. Data, so the console stays honest. */
  enforcementLocations: string[];
  /**
   * The `lib/features.ts` key this capability is ALSO written to when
   * materialized.
   *
   * `materializeEntitlements` writes TenantFeature rows under the canonical
   * key (`commerce.shopify_live_chat`). The product's own gate reads the
   * legacy key (`shopify_live_chat`). Both live in `tenant_features`, but they
   * are different rows - so without this bridge a plan could grant or withhold
   * the capability and the gate protecting it would never notice.
   *
   * Set this instead of adding `requireEntitlement` next to an existing
   * `requireFeature`: the route keeps one gate, one DB read, and no new
   * failure mode, and the commercial answer still reaches it.
   */
  materializesTo?: string;
  customerVisible: boolean;
  sysadminOnly?: boolean;
  /** False = built into the catalog but NOT shipped. Never sellable. */
  implemented: boolean;
  sortOrder: number;
}

const bool = (v: boolean) => ({ bool: v });
const count = (v: number) => ({ count: v });

// ─── Communication ──────────────────────────────────────────────────────────

const COMMUNICATION: FeatureDef[] = [
  {
    key: "communication.omnichannel",
    nameEn: "Omnichannel inbox",
    nameHe: "תיבה מאוחדת רב-ערוצית",
    descriptionEn: "One shared inbox for every connected messaging channel.",
    descriptionHe: "תיבה משותפת אחת לכל ערוצי ההודעות המחוברים.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/conversation:list", "packages/shared:assertFeature"],
    customerVisible: true,
    implemented: true,
    sortOrder: 10,
  },
  {
    key: "communication.broadcasts",
    nameEn: "Broadcasts",
    nameHe: "שידורים",
    descriptionEn: "Send a templated message to a segmented audience.",
    descriptionHe: "שליחת הודעה מבוססת תבנית לקהל מפולח.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/conversation:broadcasts.create"],
    customerVisible: true,
    implemented: true,
    sortOrder: 20,
  },
  {
    key: "communication.automations",
    nameEn: "Automations",
    nameHe: "אוטומציות",
    descriptionEn: "Visual flows that route, reply and act without an agent.",
    descriptionHe: "תהליכים חזותיים שמנתבים, משיבים ופועלים ללא נציג.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/chatbot:flows.create"],
    customerVisible: true,
    implemented: true,
    sortOrder: 30,
  },
  {
    key: "communication.social_engagement",
    nameEn: "Social engagement",
    nameHe: "מעורבות ברשתות חברתיות",
    descriptionEn: "Turn comments on social posts into private conversations.",
    descriptionHe: "הפיכת תגובות על פוסטים ברשתות לשיחות פרטיות.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/incoming-worker:comment-trigger"],
    customerVisible: true,
    implemented: true,
    sortOrder: 40,
  },
  {
    key: "communication.crm_summaries",
    nameEn: "CRM conversation summaries",
    nameHe: "סיכומי שיחה ל-CRM",
    descriptionEn: "Write a structured conversation summary back to your CRM.",
    descriptionHe: "כתיבת סיכום שיחה מובנה בחזרה ל-CRM שלך.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/ai:post-conversation.summary"],
    customerVisible: true,
    implemented: true,
    sortOrder: 50,
  },
  // ── Commerce channel capabilities ────────────────────────────────────────
  //
  // These three were gated ONLY by the legacy `Feature` enum (requireFeature),
  // which resolves a tenant's access through `tenant_features`. They had no
  // catalog key, so nothing ever materialised a row for them and
  // `isFeatureEnabledForTenant` fell through to `FEATURE_METADATA.defaultEnabled`.
  //
  // The consequence was not that they were blocked — `defaultEnabled` is TRUE
  // for the Shopify pair, so everyone had them. The consequence was that they
  // could not be SOLD: no PlanVersion could grant or withhold them, because
  // there was no key to grant. Availability was decided by a hardcoded default
  // in a TypeScript file rather than by what the customer bought.
  //
  // `defaultValue` below deliberately mirrors today's `defaultEnabled` so this
  // change is behaviour-preserving: adding the key must not take a capability
  // away from a tenant who has it right now. Restricting them to specific plans
  // is a commercial decision, made in plan seeds, not here.
  //
  // NOTE: this does NOT replace the requireFeature gate. That gate also carries
  // the per-user/per-role dimension (240 tenant_role_features rows), which
  // entitlements do not model. Billing says what the tenant bought; RBAC says
  // which actor may use it. Both still apply.
  {
    key: "commerce.shopify_live_chat",
    nameEn: "Shopify live chat",
    nameHe: "צ'אט חי לשופיפיי",
    descriptionEn: "Storefront chat widget for your Shopify store.",
    descriptionHe: "ווידג'ט צ'אט בחנות השופיפיי שלך.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true), // mirrors FEATURES.SHOPIFY_LIVE_CHAT defaultEnabled
    enforcementLocations: ["services/ai:shopify-live-chat.routes (via requireFeature)"],
    materializesTo: "shopify_live_chat",
    customerVisible: true,
    implemented: true,
    sortOrder: 60,
  },
  {
    key: "commerce.shopify_product_messaging",
    nameEn: "Shopify product messaging",
    nameHe: "הודעות מוצר בשופיפיי",
    descriptionEn: "Send product cards and carousels into the conversation.",
    descriptionHe: "שליחת כרטיסי מוצר וקרוסלות לתוך השיחה.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true), // mirrors FEATURES.SHOPIFY_PRODUCT_MESSAGING defaultEnabled
    enforcementLocations: ["services/ai:shopify-live-chat.routes (via requireFeature)"],
    materializesTo: "shopify_product_messaging",
    customerVisible: true,
    implemented: true,
    sortOrder: 61,
  },
  {
    key: "commerce.auto_buy",
    nameEn: "Automatic purchasing",
    nameHe: "רכישה אוטומטית",
    descriptionEn: "Let the AI complete a purchase on the customer's behalf.",
    descriptionHe: "מתן אפשרות ל-AI להשלים רכישה עבור הלקוח.",
    category: "COMMUNICATION",
    entitlementType: "BOOLEAN",
    // Deliberately FALSE, unlike the two above: this one spends a customer's
    // money. `FEATURES.AUTO_BUY` has no explicit defaultEnabled, so the legacy
    // resolver already fell back to `?? false` — this preserves that, it does
    // not tighten it.
    defaultValue: bool(false),
    enforcementLocations: ["services/conversation:auto-buy.routes (via requireFeature)"],
    materializesTo: "auto_buy",
    customerVisible: true,
    implemented: true,
    sortOrder: 62,
  },
];

// ─── AI & data ──────────────────────────────────────────────────────────────

const AI: FeatureDef[] = [
  {
    key: "ai.department_router",
    nameEn: "Department AI router",
    nameHe: "ניתוב AI למחלקות",
    descriptionEn: "Route each conversation to the right department automatically.",
    descriptionHe: "ניתוב אוטומטי של כל שיחה למחלקה הנכונה.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/incoming-worker:router"],
    customerVisible: true,
    implemented: true,
    sortOrder: 110,
  },
  {
    key: "ai.command_center",
    nameEn: "AI command center",
    nameHe: "מרכז הפיקוד",
    descriptionEn: "Ask questions and run actions across the workspace in one place.",
    descriptionHe: "שאלות ופעולות על כל סביבת העבודה במקום אחד.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/ai:command-center"],
    customerVisible: true,
    implemented: true,
    sortOrder: 120,
  },
  {
    key: "ai.knowledge_base",
    nameEn: "Knowledge base",
    nameHe: "מאגר ידע",
    descriptionEn: "Ground answers in your own documents and sources.",
    descriptionHe: "עיגון התשובות במסמכים ובמקורות שלך.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/incoming-worker:knowledge-retrieval"],
    customerVisible: true,
    implemented: true,
    sortOrder: 130,
  },
  {
    key: "ai.customer_360",
    nameEn: "Customer 360",
    nameHe: "תמונת לקוח מלאה",
    descriptionEn: "Every fact, order and past conversation about one customer.",
    descriptionHe: "כל עובדה, הזמנה ושיחה קודמת על לקוח אחד.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/conversation:customer-profile"],
    customerVisible: true,
    implemented: true,
    sortOrder: 140,
  },
  {
    key: "ai.sentiment_analysis",
    nameEn: "Sentiment analysis",
    nameHe: "ניתוח סנטימנט",
    descriptionEn: "Track how each conversation is actually going.",
    descriptionHe: "מעקב אחר האופן שבו כל שיחה באמת מתנהלת.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/ai:intelligence.sentiment"],
    customerVisible: true,
    implemented: true,
    sortOrder: 150,
  },
  {
    key: "ai.usage_tracking",
    nameEn: "Usage tracking",
    nameHe: "מעקב שימוש",
    descriptionEn: "See where your credits go, by channel and by employee.",
    descriptionHe: "לראות לאן הולכים הקרדיטים, לפי ערוץ ולפי עובד.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/billing:credit-summary"],
    customerVisible: true,
    implemented: true,
    sortOrder: 160,
  },
  {
    key: "ai.action_approval",
    nameEn: "Action approval",
    nameHe: "אישור פעולות",
    descriptionEn: "Hold sensitive AI actions for a human decision before they run.",
    descriptionHe: "עצירת פעולות AI רגישות להחלטת אדם לפני ביצוען.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/ai:hitl", "services/conversation:approvals"],
    customerVisible: true,
    implemented: true,
    sortOrder: 170,
  },
  {
    key: "ai.copilot",
    nameEn: "Chat Copilot",
    nameHe: "קופיילוט צ'אט",
    descriptionEn: "Drafts, next-best-actions and context for your human agents.",
    descriptionHe: "טיוטות, פעולות מומלצות והקשר לנציגים האנושיים שלך.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: ["services/ai:copilot.suggest"],
    customerVisible: true,
    implemented: true,
    sortOrder: 180,
  },
  {
    key: "ai.employee",
    nameEn: "AI Employee",
    nameHe: "עובד AI",
    descriptionEn: "An autonomous employee that handles conversations end to end.",
    descriptionHe: "עובד אוטונומי שמטפל בשיחות מקצה לקצה.",
    category: "AI",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: ["services/auth:agents.create", "services/ai:ai-bot.reply"],
    customerVisible: true,
    implemented: true,
    sortOrder: 190,
  },
];

// ─── Voice ──────────────────────────────────────────────────────────────────

const VOICE: FeatureDef[] = [
  {
    key: "voice.call_pilot",
    nameEn: "Call Pilot",
    nameHe: "טייס שיחות",
    descriptionEn: "AI on live phone calls, with playbooks and live guidance.",
    descriptionHe: "AI בשיחות טלפון חיות, עם תסריטים והכוונה בזמן אמת.",
    category: "VOICE",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: ["services/voice-copilot:session.start"],
    customerVisible: true,
    implemented: true,
    sortOrder: 210,
  },
  {
    key: "voice.call_summary",
    nameEn: "AI call summaries",
    nameHe: "סיכומי שיחות AI",
    descriptionEn: "Every call summarised, with action items, after it ends.",
    descriptionHe: "כל שיחה מסוכמת, כולל משימות המשך, מיד בסיומה.",
    category: "VOICE",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: ["services/voice-copilot:post-processing"],
    customerVisible: true,
    implemented: true,
    sortOrder: 220,
  },
  {
    key: "voice.inbound",
    nameEn: "Inbound calls",
    nameHe: "שיחות נכנסות",
    descriptionEn: "Answer inbound calls with an AI voice agent.",
    descriptionHe: "מענה לשיחות נכנסות באמצעות סוכן קולי.",
    category: "VOICE",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: ["services/voice-copilot:inbound"],
    customerVisible: true,
    implemented: true,
    sortOrder: 230,
  },
  {
    key: "voice.outbound",
    nameEn: "Outbound calls",
    nameHe: "שיחות יוצאות",
    descriptionEn: "Place outbound calls from the dialer or from an automation.",
    descriptionHe: "ביצוע שיחות יוצאות מהחייגן או מתוך אוטומציה.",
    category: "VOICE",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: ["services/voice-copilot:outbound"],
    customerVisible: true,
    implemented: true,
    sortOrder: 240,
  },
];

// ─── Management ─────────────────────────────────────────────────────────────

const MANAGEMENT: FeatureDef[] = [
  {
    key: "manager.integrations",
    nameEn: "Integrations",
    nameHe: "אינטגרציות",
    descriptionEn: "Connect your CRM, calendar, store and back-office systems.",
    descriptionHe: "חיבור ה-CRM, היומן, החנות ומערכות הבק-אופיס שלך.",
    category: "MANAGEMENT",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/auth:integrations.connect"],
    customerVisible: true,
    implemented: true,
    sortOrder: 310,
  },
  {
    key: "manager.dashboard",
    nameEn: "Manager dashboard",
    nameHe: "לוח בקרה למנהל",
    descriptionEn: "Volume, resolution and response metrics across the workspace.",
    descriptionHe: "מדדי נפח, סגירה ותגובה על פני כל סביבת העבודה.",
    category: "MANAGEMENT",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/analytics:dashboard"],
    customerVisible: true,
    implemented: true,
    sortOrder: 320,
  },
  {
    key: "manager.representative_tracking",
    nameEn: "Representative tracking",
    nameHe: "מעקב אחר נציגים",
    descriptionEn: "Per-agent quality scores, presence and workload.",
    descriptionHe: "ציוני איכות, נוכחות ועומס לכל נציג.",
    category: "MANAGEMENT",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/analytics:agent-scores"],
    customerVisible: true,
    implemented: true,
    sortOrder: 330,
  },
  {
    key: "manager.data_retention",
    nameEn: "Configurable data retention",
    nameHe: "מדיניות שמירת מידע",
    descriptionEn: "Decide how long conversations and media are kept.",
    descriptionHe: "קביעה כמה זמן נשמרות שיחות ומדיה.",
    category: "MANAGEMENT",
    entitlementType: "BOOLEAN",
    defaultValue: bool(true),
    enforcementLocations: ["services/auth:gdpr.retention"],
    customerVisible: true,
    implemented: true,
    sortOrder: 340,
  },
  {
    key: "manager.support",
    nameEn: "Support level",
    nameHe: "רמת תמיכה",
    descriptionEn: "How quickly the GOTCHA team responds to you.",
    descriptionHe: "מהירות התגובה של צוות GOTCHA אליך.",
    category: "MANAGEMENT",
    entitlementType: "ENUM",
    defaultValue: { value: "standard" },
    enforcementLocations: [],
    customerVisible: true,
    implemented: true,
    sortOrder: 350,
  },
  // ── Catalogued but NOT shipped. Never sellable while `implemented` is false.
  {
    key: "manager.auto_csat",
    nameEn: "Automatic CSAT",
    nameHe: "סקר שביעות רצון אוטומטי",
    descriptionEn: "Ask every customer to rate the conversation once it closes.",
    descriptionHe: "בקשת דירוג מכל לקוח בסיום השיחה.",
    category: "MANAGEMENT",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: [],
    customerVisible: false,
    implemented: false,
    sortOrder: 360,
  },
  {
    key: "manager.backoffice_automation",
    nameEn: "Back-office automation",
    nameHe: "אוטומציה של בק-אופיס",
    descriptionEn: "Run back-office workflows triggered by conversation outcomes.",
    descriptionHe: "הרצת תהליכי בק-אופיס לפי תוצאות שיחה.",
    category: "MANAGEMENT",
    entitlementType: "BOOLEAN",
    defaultValue: bool(false),
    enforcementLocations: [],
    customerVisible: false,
    implemented: false,
    sortOrder: 370,
  },
];

// ─── Numeric limits ─────────────────────────────────────────────────────────
// COUNTER entitlements. `-1` means unlimited (see `UNLIMITED_LIMIT`).

export const UNLIMITED_LIMIT = -1;

const LIMITS: FeatureDef[] = [
  limit("limit:users", "Team members", "חברי צוות", 3, "services/auth:users.create", 410),
  limit("limit:ai_employees", "AI employees", "עובדי AI", 0, "services/auth:agents.create", 420),
  limit("limit:channels", "Connected channels", "ערוצים מחוברים", 2, "services/auth:channels.connect", 430),
  limit("limit:departments", "Departments", "מחלקות", 3, "services/auth:departments.create", 440),
  limit("limit:knowledge_sources", "Knowledge sources", "מקורות ידע", 10, "services/auth:knowledge.create", 450),
  limit("limit:workflows", "Automations", "אוטומציות", 5, "services/chatbot:flows.create", 460),
  limit("limit:voice_channels", "Voice channels", "ערוצי קול", 0, "services/voice-copilot:channels.create", 470),
  limit("limit:storage_gb", "Storage (GB)", "אחסון (ג'יגה)", 5, "services/conversation:media.upload", 480),
  limit("limit:data_retention_days", "Data retention (days)", "שמירת מידע (ימים)", 180, "services/auth:gdpr.retention", 490),
  limit("limit:included_ai_units", "Included monthly credits", "קרדיטים חודשיים כלולים", 0, "services/billing:rollover", 500),
];

function limit(
  key: string,
  nameEn: string,
  nameHe: string,
  def: number,
  where: string,
  sortOrder: number,
): FeatureDef {
  return {
    key,
    nameEn,
    nameHe,
    descriptionEn: `Maximum ${nameEn.toLowerCase()} allowed on the plan.`,
    descriptionHe: `המספר המרבי של ${nameHe} המותר בתוכנית.`,
    category: "MANAGEMENT",
    entitlementType: "COUNTER",
    defaultValue: count(def),
    enforcementLocations: [where, "packages/shared:assertLimit"],
    customerVisible: true,
    implemented: true,
    sortOrder,
  };
}

// ─── Catalog ────────────────────────────────────────────────────────────────

export const FEATURE_CATALOG: readonly FeatureDef[] = [
  ...COMMUNICATION,
  ...AI,
  ...VOICE,
  ...MANAGEMENT,
  ...LIMITS,
];

const BY_KEY = new Map(FEATURE_CATALOG.map((f) => [f.key, f]));
const LICENSE_KEYS = new Set(ALL_LICENSE_KEYS);

export function getFeatureDef(key: string): FeatureDef | undefined {
  return BY_KEY.get(key);
}

/** Keys that may legally appear on a plan (built, and therefore sellable). */
export function sellableFeatureKeys(): string[] {
  return FEATURE_CATALOG.filter((f) => f.implemented).map((f) => f.key);
}

/**
 * True when the key is catalogued but not shipped, or is not a sellable key at
 * all.
 *
 * There are TWO key namespaces and this function has to know it. This catalog
 * holds fine-grained capabilities with dotted keys (`ai.copilot`). The
 * permission catalog holds the LICENSE keys a plan actually sells: the
 * top-level domains (`ai`, `conversation`, `channels`) and their colon
 * sub-keys (`ai:employees`). They are different sets, and only the first one
 * is in `BY_KEY`.
 *
 * Treating everything outside this catalog as unsellable therefore denied every
 * license domain, permanently and silently. A plan declaring `ai: true` was
 * overridden to false by the guard, `materializeEntitlements` wrote that false
 * into TenantFeature, `getUserPermissions` dropped every permission licensed by
 * the domain, and the workspace navigation lost most of its categories. The
 * plan said yes; the tenant saw a nearly empty product.
 *
 * Unknown keys are still unsellable, which is the protection this guard exists
 * for - a typo in a plan must not silently sell something that does not exist.
 */
export function isUnsellable(key: string): boolean {
  const def = BY_KEY.get(key);
  if (def) return !def.implemented;
  // A real license key from the other namespace. Sellable by definition: it is
  // how packaging is expressed.
  if (LICENSE_KEYS.has(key)) return false;
  return true;
}

export function featuresByCategory(category: FeatureCategory): FeatureDef[] {
  return FEATURE_CATALOG.filter((f) => f.category === category).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Every BOOLEAN capability key (excludes COUNTER limits and ENUM config). */
export const BOOLEAN_FEATURE_KEYS: readonly string[] = FEATURE_CATALOG.filter(
  (f) => f.entitlementType === "BOOLEAN",
).map((f) => f.key);

/** Every COUNTER limit key. */
export const LIMIT_KEYS: readonly string[] = LIMITS.map((f) => f.key);
