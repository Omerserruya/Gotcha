/**
 * Conversation relevance in the inbox (2026-11-17, docs/architecture/conversation-relevance.md).
 * One definition of "not relevant" for every reader: the inbox list, its counts and the Home's
 * waiting figures. Needs the a6459560 columns.
 */
export const RELEVANCE_CATEGORY_VALUES = ["business", "reply_to_outbound", "personal", "notice", "marketing", "auto_reply", "internal", "unclear"] as const;
export type ConversationRelevanceCategory = (typeof RELEVANCE_CATEGORY_VALUES)[number];
/**
 * The labels that take a conversation out of the working views into "not relevant". `internal` (the team's
 * own chats) keeps the AI out but stays in the normal views with its own tag (2026-11-17).
 */
export const IRRELEVANT_CATEGORIES: readonly ConversationRelevanceCategory[] = ["personal", "notice", "marketing", "auto_reply"];
/** What a person may set by hand. */
export const RELEVANCE_OVERRIDES: readonly ConversationRelevanceCategory[] = ["business", "personal"];

/** Conversations labelled not relevant. */
export function irrelevantWhere(): any {
  return { relevanceCategory: { in: [...IRRELEVANT_CATEGORIES] } };
}

/**
 * Everything else, the unlabelled included. Written as an OR with an explicit null branch: a
 * NOT IN over a NULL column is NULL in SQL and would drop every conversation never classified.
 */
export function notIrrelevantWhere(): any {
  return { OR: [{ relevanceCategory: null }, { relevanceCategory: { notIn: [...IRRELEVANT_CATEGORIES] } }] };
}

export interface ConversationRelevanceView {
  category: ConversationRelevanceCategory;
  confidence: number | null;
  reason: string | null;
  source: string | null;
  classifiedAt: string | null;
  overriddenBy: string | null;
  overriddenAt: string | null;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null);

/** The row's relevance object for the API (null when never classified); an unknown value reads as unclear. */
export function presentRelevance(row: any): ConversationRelevanceView | null {
  if (!row || row.relevanceCategory == null) return null;
  const category = (RELEVANCE_CATEGORY_VALUES as readonly string[]).includes(row.relevanceCategory) ? row.relevanceCategory : "unclear";
  return {
    category,
    confidence: typeof row.relevanceConfidence === "number" ? row.relevanceConfidence : null,
    reason: row.relevanceReason ?? null,
    source: row.relevanceSource ?? null,
    classifiedAt: iso(row.relevanceClassifiedAt),
    overriddenBy: row.relevanceOverriddenBy ?? null,
    overriddenAt: iso(row.relevanceOverriddenAt),
  };
}

/** A row with its raw relevance_* columns folded into one `relevance` object. */
type RelevanceColumn = "relevanceCategory" | "relevanceConfidence" | "relevanceReason" | "relevanceSource" | "relevanceClassifiedAt" | "relevanceOverriddenBy" | "relevanceOverriddenAt";
export function withRelevance<T extends object>(row: T): Omit<T, RelevanceColumn> & { relevance: ConversationRelevanceView | null } {
  const { relevanceCategory, relevanceConfidence, relevanceReason, relevanceSource, relevanceClassifiedAt, relevanceOverriddenBy, relevanceOverriddenAt, ...rest } = row as any;
  return { ...rest, relevance: presentRelevance(row) };
}
