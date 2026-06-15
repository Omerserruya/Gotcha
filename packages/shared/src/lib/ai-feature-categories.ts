/**
 * AI feature → product-area category mapping.
 *
 * The `UsageLog.feature` column records WHICH code path spent tokens
 * (e.g. "ai_bot", "suggestion", "voice_copilot"). For the pricing-model
 * admin view we need to roll those raw labels into the customer-facing
 * product surfaces: Autonomous Agent, Co-pilot, Call-pilot, etc.
 *
 * Single source of truth - backend (raw SQL CASE) and frontend (display
 * labels) both derive from this list.
 */

export type AiFeatureCategory =
  | "autonomous_agent"
  | "copilot_inbox"
  | "call_pilot"
  | "embedded_chat"
  | "system_copilot"
  | "background_ai"
  | "embeddings"
  | "other";

export interface AiFeatureCategoryDef {
  key: AiFeatureCategory;
  label: string;
  /** Marketing-style one-liner shown beneath the category title. */
  description: string;
  /** Tailwind colour family used for cards/charts. */
  color: string;
  /** Exact feature labels that roll up into this category. */
  features: string[];
  /** Feature labels matched by prefix (covers e.g. all `voice_*`). */
  prefixes?: string[];
  /**
   * Whether the category is priced on a per-conversation basis (one charge per
   * customer thread, regardless of LLM round-trips). When false the natural
   * unit is the call (per-turn) - e.g. embeddings or one-shot classifications.
   */
  perConversation: boolean;
}

export const AI_FEATURE_CATEGORIES: AiFeatureCategoryDef[] = [
  {
    key: "autonomous_agent",
    label: "Autonomous Agent",
    description: "AI bot that answers customers end-to-end across channels.",
    color: "violet",
    features: ["ai_bot", "ai_bot_retry", "ai_bot_retry_final", "comment_reply"],
    perConversation: true,
  },
  {
    key: "copilot_inbox",
    label: "Inbox Co-pilot",
    description: "Suggested replies and compose-assist for human agents.",
    color: "blue",
    features: ["suggestion", "compose"],
    perConversation: true,
  },
  {
    key: "call_pilot",
    label: "Call-pilot (Voice)",
    description: "Live voice copilot during calls (AI tokens only - excludes STT/TTS).",
    color: "rose",
    features: ["voice_copilot", "voice_assist", "voice_summary"],
    prefixes: ["voice_"],
    perConversation: true,
  },
  {
    key: "embedded_chat",
    label: "Embedded Chat Widget",
    description: "Website chat widget powered by the platform.",
    color: "emerald",
    features: ["chat"],
    perConversation: true,
  },
  {
    key: "system_copilot",
    label: "System Copilot",
    description: "Admin / agent-configuration helper inside the console.",
    color: "amber",
    features: ["system_copilot", "agent_description"],
    perConversation: false,
  },
  {
    key: "background_ai",
    label: "Background AI",
    description: "Post-conversation summary, intent, followups, briefs.",
    color: "slate",
    features: [
      "summary",
      "classification",
      "intent_classify",
      "intent_batch",
      "action_plan",
      "action_simulate",
      "customer_brief",
      "post_conversation_summary",
      "followup",
      "knowledge_retrieval",
      "onboarding",
    ],
    perConversation: false,
  },
  {
    key: "embeddings",
    label: "Embeddings",
    description: "Vector embeddings for knowledge retrieval.",
    color: "indigo",
    features: ["embedding"],
    perConversation: false,
  },
];

export const AI_CATEGORY_ORDER: AiFeatureCategory[] = [
  "autonomous_agent",
  "copilot_inbox",
  "call_pilot",
  "embedded_chat",
  "system_copilot",
  "background_ai",
  "embeddings",
  "other",
];

const FEATURE_TO_CATEGORY: Map<string, AiFeatureCategory> = (() => {
  const m = new Map<string, AiFeatureCategory>();
  for (const def of AI_FEATURE_CATEGORIES) {
    for (const f of def.features) m.set(f, def.key);
  }
  return m;
})();

export function categorizeFeature(feature: string | null | undefined): AiFeatureCategory {
  if (!feature) return "other";
  const exact = FEATURE_TO_CATEGORY.get(feature);
  if (exact) return exact;
  for (const def of AI_FEATURE_CATEGORIES) {
    for (const p of def.prefixes ?? []) {
      if (feature.startsWith(p)) return def.key;
    }
  }
  return "other";
}

export function categoryLabel(category: AiFeatureCategory): string {
  return AI_FEATURE_CATEGORIES.find((d) => d.key === category)?.label ?? "Other";
}

/**
 * Postgres SQL fragment that classifies a row's `feature` column into one of
 * the categories above. Kept in this file so backend SQL and frontend display
 * stay in sync - change the list above, both sides update.
 */
export function categorySqlCase(featureColumn = "feature"): string {
  const whens: string[] = [];
  for (const def of AI_FEATURE_CATEGORIES) {
    if (def.features.length > 0) {
      const quoted = def.features.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
      whens.push(`WHEN ${featureColumn} IN (${quoted}) THEN '${def.key}'`);
    }
    for (const p of def.prefixes ?? []) {
      whens.push(`WHEN ${featureColumn} LIKE '${p.replace(/'/g, "''")}%' THEN '${def.key}'`);
    }
  }
  return `CASE ${whens.join(" ")} ELSE 'other' END`;
}
