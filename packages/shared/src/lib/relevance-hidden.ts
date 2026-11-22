/**
 * Hidden conversations get NO automation (2026-11-22, Omer: a business number that is also used personally).
 *
 * One rule for every path that can act on an inbound conversation: Studio automations, flows, routing and
 * auto-assignment, the AI, the team's new-message pushes, the "customer is waiting" alert, the idle bot,
 * scheduled follow-ups an automation or the AI made, and the ai's live extraction, copilot and post-chat work.
 * The reply engine's Gate 1 stays as its own second line.
 *
 * Hidden:
 *   - a person marked the conversation personal by hand (on any account: a hand mark always counts);
 *   - or the classifier labelled it personal, notice, marketing, auto_reply or internal at confidence >= 0.7,
 *     on an account whose relevance filter is on (the inbox's own rule, irrelevantWhere, plus internal: the
 *     team's own chats are visible in the inbox but a teammate is not a customer to automate).
 * Never hidden: a person's "business" mark, whatever the classifier said; reply_to_outbound, business and
 * unclear; no label at all.
 *
 * A read that fails counts as NOT hidden: the conversation is treated as it was before labels existed.
 */
import { IRRELEVANT_CATEGORIES, type ConversationRelevanceCategory } from "./conversation-relevance";

export const HIDDEN_CONFIDENCE = 0.7;
/** The labels that stop every automation. */
export const AUTOMATION_HIDDEN_CATEGORIES: readonly ConversationRelevanceCategory[] = [...IRRELEVANT_CATEGORIES, "internal"];

export interface RelevanceRow {
  relevanceCategory?: string | null;
  relevanceConfidence?: number | null;
  relevanceOverriddenBy?: string | null;
}

/** Pure. `filterOn`: the conversation's channel account keeps the relevance filter on (its default). */
export function relevanceHidden(row: RelevanceRow | null | undefined, filterOn: boolean): boolean {
  const category = row?.relevanceCategory ?? null;
  if (!category || !(AUTOMATION_HIDDEN_CATEGORIES as readonly string[]).includes(category)) return false;
  if (row?.relevanceOverriddenBy) return true;
  if (!filterOn) return false;
  return Number(row?.relevanceConfidence ?? 0) >= HIDDEN_CONFIDENCE;
}

/** The SQL twin of relevanceHidden for a Prisma where (the rows that are NOT hidden). */
export function notHiddenWhere(): any {
  const hidden = [...AUTOMATION_HIDDEN_CATEGORIES];
  return {
    OR: [
      { relevanceCategory: null },
      { relevanceCategory: { notIn: hidden } },
      {
        AND: [
          { relevanceOverriddenBy: null },
          { OR: [{ relevanceConfidence: null }, { relevanceConfidence: { lt: HIDDEN_CONFIDENCE } }, { channelAccount: { is: { relevanceFilterEnabled: false } } }] },
        ],
      },
    ],
  };
}

/** One conversation, read now. Never throws; a missing row or a failed read is not hidden. */
export async function isConversationHidden(tenantId: string, conversationId: string | null | undefined, db?: any): Promise<boolean> {
  if (!tenantId || !conversationId) return false;
  try {
    // Loaded here, not at the top: the pure rules above are imported by paths that never read.
    db ??= (await import("./prisma")).prisma;
    const row = await db.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: {
        relevanceCategory: true,
        relevanceConfidence: true,
        relevanceOverriddenBy: true,
        channelAccount: { select: { relevanceFilterEnabled: true } },
      },
    });
    if (!row) return false;
    return relevanceHidden(row, row.channelAccount?.relevanceFilterEnabled !== false);
  } catch (err) {
    console.warn("[relevance] hidden read failed, the conversation is treated as visible:", (err as Error)?.message);
    return false;
  }
}

/** The log line every skipping path writes: the path, the conversation, nothing about its content. */
export function logHiddenSkip(path: string, conversationId: string): void {
  console.log(`[relevance] skip=${path} conv=${conversationId} reason=hidden_label`);
}
