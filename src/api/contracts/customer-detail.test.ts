import { describe, expect, it } from 'vitest';

import {
  conversationsIn,
  hasBrief,
  hasMemory,
  moreConversationsExist,
  newestConversationId,
  timelineEventSchema,
  timelineSchema,
  truncatedConversations,
  TIMELINE_CONVERSATION_CAP,
  TIMELINE_MESSAGES_PER_CONVERSATION,
  type TimelineEvent,
} from './customer-detail';

const event = (over: Partial<TimelineEvent> = {}): TimelineEvent =>
  timelineEventSchema.parse({
    type: 'message',
    channel: 'WHATSAPP',
    conversationId: 'c1',
    direction: 'INBOUND',
    body: 'hello',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...over,
  });

describe('★ the timeline is a sample and the helpers have to say so', () => {
  it('counts distinct conversations, not events', () => {
    const events = [
      event(),
      event({ createdAt: '2026-09-01T11:00:00.000Z' }),
      event({ conversationId: 'c2' }),
    ];
    expect(conversationsIn(events)).toEqual(['c1', 'c2']);
  });

  it('★ reports more conversations exist once the cap is reached', () => {
    /*
     * `identity.ts:233` — `take: 50`. Fifty distinct conversations means the
     * route stopped counting, not that the person has exactly fifty.
     */
    const under = Array.from({ length: TIMELINE_CONVERSATION_CAP - 1 }, (_, i) =>
      event({ conversationId: `c${i}` }),
    );
    expect(moreConversationsExist(under)).toBe(false);

    const at = Array.from({ length: TIMELINE_CONVERSATION_CAP }, (_, i) =>
      event({ conversationId: `c${i}` }),
    );
    expect(moreConversationsExist(at)).toBe(true);
  });

  it('★ names conversations whose tail is all we have', () => {
    /*
     * `take: 5` per conversation. A conversation contributing five messages
     * here either HAD five or had five hundred — the payload cannot tell
     * them apart, which is exactly why the screen must not imply it can.
     */
    const five = Array.from({ length: TIMELINE_MESSAGES_PER_CONVERSATION }, (_, i) =>
      event({ createdAt: `2026-09-01T1${i}:00:00.000Z` }),
    );
    const four = Array.from({ length: TIMELINE_MESSAGES_PER_CONVERSATION - 1 }, (_, i) =>
      event({ conversationId: 'c2', createdAt: `2026-09-02T1${i}:00:00.000Z` }),
    );
    expect(truncatedConversations([...five, ...four])).toEqual(['c1']);
  });

  it('★ a second event kind fails the parse rather than rendering as a message', () => {
    /*
     * `type` is `z.literal('message')` because the producer's union has
     * exactly one member. If an `order` event ever arrives, this must break
     * loudly here — a wider schema would let the screen draw an order as a
     * message body and nobody would see it.
     *
     * The opposite direction from `roles.2.source`: there the enum was too
     * narrow for the producer, here it matches and must stay matched.
     */
    expect(() => timelineEventSchema.parse({ ...event(), type: 'order' })).toThrow();
  });

  it('finds the newest conversation, which is the only key to the brief', () => {
    // `POST /customer-summary` requires a conversationId. No conversations,
    // no brief — a fact about the person, not a failure.
    const events = [
      event({ conversationId: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      event({ conversationId: 'new', createdAt: '2026-09-09T00:00:00.000Z' }),
    ];
    expect(newestConversationId(events)).toBe('new');
    expect(newestConversationId([])).toBeNull();
  });

  it('keeps the EFFECTIVE contact, because the page may be opened by a merged id', () => {
    // The route follows `mergedIntoId`. The name shown must be the survivor's,
    // not the one the list happened to hold.
    const parsed = timelineSchema.parse({
      contact: { id: 'survivor', displayName: 'Dana', externalId: '+972500000000' },
      events: [],
    });
    expect(parsed.contact?.id).toBe('survivor');
  });
});

describe('an empty answer is not a failed one', () => {
  it('★ distinguishes “no brief written” from “brief with no prose”', () => {
    // `ok: true` with a null summary is a real answer — the row exists and
    // the prose has not been written. Rendering it would be an empty italic
    // paragraph, which reads as a summary that says nothing about them.
    expect(hasBrief(null)).toBe(false);
    expect(
      hasBrief({
        ok: true,
        summary: null,
        signals: [],
        generated_at: null,
        cached: false,
        meta: {
          conversation_count: null,
          channels: [],
          tone: null,
          mood: null,
          recommended_behaviors: [],
        },
      }),
    ).toBe(false);
    expect(
      hasBrief({
        ok: true,
        summary: '   ',
        signals: [],
        generated_at: null,
        cached: false,
        meta: {
          conversation_count: null,
          channels: [],
          tone: null,
          mood: null,
          recommended_behaviors: [],
        },
      }),
    ).toBe(false);
    expect(
      hasBrief({
        ok: true,
        summary: 'She asks about delivery first.',
        signals: [],
        generated_at: null,
        cached: false,
        meta: {
          conversation_count: null,
          channels: [],
          tone: null,
          mood: null,
          recommended_behaviors: [],
        },
      }),
    ).toBe(true);
  });

  it('treats a memory with a summary but no facts as present', () => {
    // The row carries both; either alone is worth showing.
    expect(
      hasMemory({
        context: {
          summary: 'Prefers Hebrew.',
          facts: [],
          messageCount: null,
          source: null,
          learnedAt: null,
        },
      }),
    ).toBe(true);
    expect(
      hasMemory({
        context: { summary: null, facts: [], messageCount: null, source: null, learnedAt: null },
      }),
    ).toBe(false);
    expect(hasMemory(null)).toBe(false);
  });
});
