import type { ConversationRow } from '@/api/contracts/inbox';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ IS THIS CONVERSATION BUSINESS? (Omer, 2026-11-17, `INBOX_RELEVANCE`)
 * ════════════════════════════════════════════════════════════════════════════
 * The platform's classifier labels each conversation (Backend's contract,
 * `conversationRowSchema.relevance`):
 *
 *   business            a customer asking the business something
 *   reply_to_outbound   a reply to a message the business sent first
 *   personal            a friend, family, a private matter
 *   notice              an invoice, a receipt, a delivery or system notice
 *   marketing           a newsletter, an advert
 *   auto_reply          another business's automatic greeting or away message
 *   internal            the workspace's own team (a member's phone or email,
 *                       the company's email domain); the AI stays out
 *   unclear             the classifier could not tell
 *
 * Personal, notice, marketing and automatic replies are "not relevant": they
 * leave the main views and their counts (`HIDES_IRRELEVANT`), live in their
 * own view, and wear a tag with their type. Internal stays in the main views
 * and wears "Team" (Backend, 2026-11-17). Everything else is a normal
 * conversation, with NO tag - a reply to our own message most of all: it is
 * the business's own thread (Omer's rule 3).
 *
 * ★ A person decides last: "This is a business enquiry" moves a tagged one
 *   back, "Mark as not relevant" moves a normal one out. The platform keeps
 *   the person's choice and never relabels it.
 */
export const RELEVANCE_CATEGORIES = [
  'business',
  'reply_to_outbound',
  'personal',
  'notice',
  'marketing',
  'auto_reply',
  'internal',
  'unclear',
] as const;
export type RelevanceCategory = (typeof RELEVANCE_CATEGORIES)[number];

/** The ones that leave the main views, each with its own tag. */
export const IRRELEVANT_CATEGORIES = ['personal', 'notice', 'marketing', 'auto_reply'] as const;
export type IrrelevantCategory = (typeof IRRELEVANT_CATEGORIES)[number];

/**
 * The tags a row can wear: the not-relevant kinds, and "Team" for the
 * workspace's own people, which stays in the main views.
 */
export const RELEVANCE_TAGS = [...IRRELEVANT_CATEGORIES, 'internal'] as const;
export type RelevanceTag = (typeof RELEVANCE_TAGS)[number];

/** What a person can set: back to business, or out as personal. */
export type RelevanceOverride = 'business' | 'personal';

/**
 * The effective category, or `null` when the conversation is not classified.
 * A value the frontend does not know is "unclear" - a normal conversation,
 * never a hidden one.
 */
export function relevanceCategory(row: {
  readonly relevance?: ConversationRow['relevance'];
}): RelevanceCategory | null {
  const category = row.relevance?.category;
  if (category === null || category === undefined || category === '') return null;
  return (RELEVANCE_CATEGORIES as readonly string[]).includes(category)
    ? (category as RelevanceCategory)
    : 'unclear';
}

/** The tag this conversation wears, or `null` for a normal one (no tag). */
export function relevanceTag(row: {
  readonly relevance?: ConversationRow['relevance'];
}): RelevanceTag | null {
  const category = relevanceCategory(row);
  return (RELEVANCE_TAGS as readonly string[]).includes(category ?? '')
    ? (category as RelevanceTag)
    : null;
}

/**
 * The one override offered: back to business when tagged, out as personal
 * when not.
 *
 * ★ "Team" offers business too: a customer read as one of our own is a
 *   customer the AI does not answer, the costlier of its two mistakes.
 */
export function relevanceOverride(row: {
  readonly relevance?: ConversationRow['relevance'];
}): RelevanceOverride {
  return relevanceTag(row) === null ? 'personal' : 'business';
}
