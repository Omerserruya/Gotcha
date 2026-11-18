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
/**
 * The channels the relevance filter applies to (2026-11-18): message channels where personal chats, notices
 * and marketing arrive. On a site or store chat and on voice the visitor is always talking to the business:
 * nothing is classified and the per-account flag means nothing.
 */
export const RELEVANCE_CHANNELS: ReadonlySet<string> = new Set(["WHATSAPP", "GMAIL", "OUTLOOK", "EMAIL", "INSTAGRAM", "MESSENGER"]);
export const relevanceChannel = (channel: unknown) => RELEVANCE_CHANNELS.has(String(channel ?? "").toUpperCase());

/** What a person may set by hand. */
export const RELEVANCE_OVERRIDES: readonly ConversationRelevanceCategory[] = ["business", "personal"];

/**
 * The channel account's relevance filter is on (its default), or the conversation has no account. A business
 * can turn the filter off per channel (2026-11-18): that channel's labels are kept but ignored, unless a person
 * set one by hand (an override wins either way).
 */
const FILTER_ON = { OR: [{ channelAccountId: null }, { channelAccount: { is: { relevanceFilterEnabled: true } } }] };

/** Conversations labelled not relevant (on a channel whose filter is on, or by a person's override). */
export function irrelevantWhere(): any {
  return { AND: [{ relevanceCategory: { in: [...IRRELEVANT_CATEGORIES] } }, { OR: [{ relevanceOverriddenBy: { not: null } }, FILTER_ON] }] };
}

/**
 * Everything else, the unlabelled included. Written as an OR with an explicit null branch: a
 * NOT IN over a NULL column is NULL in SQL and would drop every conversation never classified.
 */
export function notIrrelevantWhere(): any {
  return {
    OR: [
      { relevanceCategory: null },
      { relevanceCategory: { notIn: [...IRRELEVANT_CATEGORIES] } },
      // A label on a channel whose filter is off counts as no label, unless a person set it.
      { AND: [{ relevanceOverriddenBy: null }, { channelAccount: { is: { relevanceFilterEnabled: false } } }] },
    ],
  };
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
