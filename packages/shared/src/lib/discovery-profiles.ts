/**
 * Discovery Profiles: per-goal declaration of which facts are required vs
 * optional, how they normalize, and what action becomes ready once the
 * minimum is met. Backend-owned - the model never invents the envelope; it
 * only proposes fact VALUES for these declared keys.
 *
 * Readiness is computed deterministically in code (computeReadiness in
 * discovery-state.ts) against this profile, NOT decided by the LLM. The
 * absence of an OPTIONAL fact never blocks the ready action.
 */

export type FactValueType = "string" | "number" | "boolean" | "enum" | "range";

export interface FactSpec {
  /** Canonical semantic key. */
  key: string;
  type: FactValueType;
  required: boolean;
  /** Synonym/alias keys that normalize to `key` (multilingual dedupe). */
  aliases?: string[];
  enumValues?: string[];
  /** Human hint for the extractor prompt. */
  description?: string;
  /** Sensitivity for retention/promotion. */
  sensitivity?: "normal" | "sensitive";
  /** May this fact be promoted to long-term customer memory? Default false
   * (shopping preferences/budgets stay conversation-scoped). */
  promotable?: boolean;
}

export interface DiscoveryProfile {
  goalKey: string;
  /** Objective this profile backs (objectives.ts). */
  objective: string;
  facts: FactSpec[];
  /** The tool the ready action executes (adapter tool function name). */
  readyAction: { type: "execute_tool"; tool: string };
}

/**
 * Product recommendation: search early on the MINIMUM (category + budget +
 * use/style); everything else refines afterwards. Boot size is optional and
 * must never block the first search (it only affects waist-width advice).
 */
export const PRODUCT_RECOMMENDATION_PROFILE: DiscoveryProfile = {
  goalKey: "product_recommendation",
  objective: "PRODUCT_RECOMMENDATION",
  readyAction: { type: "execute_tool", tool: "shopify.search_products" },
  facts: [
    { key: "product_category", type: "string", required: true, aliases: ["category", "product", "item_type", "קטגוריה", "מוצר"], description: "What kind of product (e.g. snowboard, boots)." },
    { key: "budget", type: "range", required: true, aliases: ["price", "budget_usd", "תקציב", "מחיר"], description: "Approximate budget with currency." },
    { key: "riding_style", type: "enum", required: true, aliases: ["use", "terrain", "style", "סגנון", "שימוש"], enumValues: ["all_mountain", "freestyle", "freeride", "park", "carving", "powder"], description: "General use / riding style." },
    { key: "height_cm", type: "number", required: false, aliases: ["height", "גובה"], description: "Customer height in cm." },
    { key: "weight_kg", type: "number", required: false, aliases: ["weight", "משקל"], description: "Customer weight in kg." },
    { key: "preferred_length_cm", type: "range", required: false, aliases: ["length", "board_length", "אורך"], description: "Preferred board length in cm." },
    { key: "flex", type: "enum", required: false, aliases: ["stiffness", "קשיחות", "גמישות"], enumValues: ["soft", "medium", "stiff"], description: "Preferred flex." },
    { key: "boot_size", type: "number", required: false, aliases: ["boots_size", "מידת_נעל"], sensitivity: "normal", description: "Boot size (affects waist width only)." },
    { key: "include_bindings", type: "boolean", required: false, aliases: ["bindings", "ביינדינגס"], description: "Whether bindings are wanted." },
    { key: "availability", type: "enum", required: false, aliases: ["stock", "preorder", "זמינות", "מלאי"], enumValues: ["in_stock", "preorder", "both"], description: "Immediate stock vs preorder acceptance." },
  ],
};

const REGISTRY: Record<string, DiscoveryProfile> = {
  [PRODUCT_RECOMMENDATION_PROFILE.goalKey]: PRODUCT_RECOMMENDATION_PROFILE,
};

export function getDiscoveryProfile(goalKey: string): DiscoveryProfile | null {
  return REGISTRY[goalKey] ?? null;
}

/** Build the alias→canonical map for a profile (used to normalize keys). */
export function aliasMap(profile: DiscoveryProfile): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of profile.facts) {
    m.set(f.key.toLowerCase(), f.key);
    for (const a of f.aliases ?? []) m.set(a.toLowerCase(), f.key);
  }
  return m;
}

/** Canonical semantic key for a raw/aliased/multilingual key within a profile. */
export function normalizeFactKey(profile: DiscoveryProfile, rawKey: string): string | null {
  return aliasMap(profile).get(String(rawKey).trim().toLowerCase()) ?? null;
}
