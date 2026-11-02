import type { TimelineEvent } from '@/api/contracts/customer-detail';

/**
 * A customer's conversations, one row each, newest first - the shape the
 * desktop's conversation tab draws (`ConversationsTab`), cut for a phone.
 *
 * Built from the timeline's MESSAGE events only, grouped by conversation:
 * when it was last active, its channel, the customer's own latest words
 * (else anyone's), and how many messages the page holds. Handovers and AI
 * actions belong to the website's stream, not to this list.
 */
export interface ConversationLine {
  readonly id: string;
  readonly at: string;
  readonly channel: string | null;
  /** The customer's latest words in it; anyone's when they wrote none; `null` with no words. */
  readonly said: string | null;
  readonly count: number;
}

export function recentConversations(
  events: readonly TimelineEvent[],
  limit: number,
): readonly ConversationLine[] {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    if (event.type !== 'message') continue;
    groups.set(event.conversationId, [...(groups.get(event.conversationId) ?? []), event]);
  }
  return [...groups.entries()]
    .map(([id, messages]) => {
      const sorted = [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const said =
        sorted.find((m) => m.direction === 'INBOUND' && m.body?.trim()) ??
        sorted.find((m) => m.body?.trim());
      return {
        id,
        at: sorted[0]!.createdAt,
        channel: sorted[0]!.channel ?? null,
        said: said?.body?.replace(/\s+/g, ' ').trim() ?? null,
        count: messages.length,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
