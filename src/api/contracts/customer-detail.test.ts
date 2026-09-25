import { describe, expect, it } from 'vitest';

import {
  conversationsIn,
  hasBrief,
  hasMemory,
  importedEvents,
  isPartialHistory,
  newestConversationId,
  shownOfTotal,
  timelineEventSchema,
  timelineSchema,
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
    id: 'e1',
    handover: null,
    action: null,
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

  it('★★ says how many of the total are on screen, not just how many are on screen', () => {
    /*
     * The old route took 50 conversations × the newest 5 messages of each,
     * so a 300-message thread contributed five and the output was a
     * well-ordered stream WITH HOLES IN THE MIDDLE. Not truncated — thinned.
     * A truncated history is visibly short; a thinned one looks complete and
     * is undetectable from the response.
     *
     * `totals.messages` is the real count, so "50 of 1,284" is now sayable
     * and "showing recent activity" is no longer good enough.
     */
    const timeline = timelineSchema.parse({
      identityChannels: [],
      contact: null,
      events: [event(), event({ conversationId: 'c2' })],
      page: { limit: 50, types: ['message'], nextCursor: 'abc', hasMore: true },
      coverage: {},
      totals: {
        conversations: 40,
        messages: 1284,
        handovers: 0,
        aiActions: 0,
        conversationScanTruncated: false,
      },
    });
    expect(shownOfTotal(timeline)).toEqual({ shown: 2, total: 1284 });
    expect(isPartialHistory(timeline)).toBe(true);
  });

  it('does not call a complete history partial', () => {
    // The inverse, so the sentence is a statement about the data rather than
    // a hedge that is always on.
    const whole = timelineSchema.parse({
      identityChannels: [],
      contact: null,
      events: [event()],
      page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
      coverage: {},
      totals: {
        conversations: 1,
        messages: 1,
        handovers: 0,
        aiActions: 0,
        conversationScanTruncated: false,
      },
    });
    expect(isPartialHistory(whole)).toBe(false);
  });

  it('★★ separates imported messages from observed ones', () => {
    /*
     * `applyLiveByDefault` injects `origin: "LIVE"` into any bulk read that
     * does not mention origin, and this route never did — so for any customer
     * with imported WhatsApp history the timeline showed NONE of it, and a
     * long-standing customer rendered as brand new with no marker.
     *
     * Now both origins are named, and an imported message is labelled:
     * something we were told about, not something we watched happen.
     */
    const events = [event(), event({ origin: 'HISTORICAL_IMPORT', conversationId: 'c2' })];
    expect(importedEvents(events)).toHaveLength(1);
    expect(importedEvents(events)[0]!.conversationId).toBe('c2');
  });

  it('defaults origin to null rather than assuming LIVE', () => {
    // A row written before the column exists is not evidence that it was
    // observed. Guessing LIVE here is the same class of error as the guard
    // that caused the problem.
    expect(event().origin).toBeNull();
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
      identityChannels: [],
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
          reason: null,
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
          reason: null,
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
          reason: null,
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
          evidenceWindow: null,
        },
      }),
    ).toBe(true);
    expect(
      hasMemory({
        context: {
          summary: null,
          facts: [],
          messageCount: null,
          source: null,
          learnedAt: null,
          evidenceWindow: null,
        },
      }),
    ).toBe(false);
    expect(hasMemory(null)).toBe(false);
  });
});
