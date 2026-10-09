import { describe, expect, it } from 'vitest';

import {
  activityFeedSchema,
  analyticsOverviewSchema,
  inFlightSchema,
  insightsSchema,
  queueItemsSchema,
  timeSavedSchema,
  usageAllowanceSchema,
} from './analytics';

describe('analytics overview', () => {
  /*
   * The backend computes each delta as `prior > 0 ? … : null`, so a tenant in
   * its first period gets nulls. `.optional()` alone rejects those, which
   * failed the whole contract and blanked the metric strip for exactly the
   * tenants least able to diagnose it.
   */
  it('accepts null deltas, which mean "no prior period", not zero', () => {
    const parsed = analyticsOverviewSchema.parse({
      totalConversations: 4,
      deltas: {
        totalConversationsPct: null,
        resolvedConversationsPct: null,
        totalMessagesPct: null,
      },
    });
    expect(parsed.deltas?.totalConversationsPct).toBeNull();
  });
});

describe('queue items', () => {
  const row = {
    conversationId: 'c1',
    customer: { id: '+972500000000', name: null },
    channel: 'WHATSAPP',
    preview: 'Where is my order?',
    intent: 'SHIPPING_ISSUE',
    waitingSince: '2026-09-08T09:00:00.000Z',
    urgency: 'high',
    rank: 1,
  };

  it('parses a page and keeps the queue depth separate from the page length', () => {
    const parsed = queueItemsSchema.parse({
      data: [row],
      nextCursor: '20',
      totalWaiting: 21,
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.totalWaiting).toBe(21);
  });

  /*
   * A new intent or urgency grade shipped by the backend must not fail the
   * parse: that would blank the entire list rather than one label.
   */
  it('survives a grade it has never seen', () => {
    const parsed = queueItemsSchema.parse({
      data: [{ ...row, urgency: 'critical', intent: 'PRICE_MATCH' }],
      totalWaiting: 1,
    });
    expect(parsed.data[0]?.urgency).toBe('none');
    expect(parsed.data[0]?.intent).toBe('PRICE_MATCH');
  });
});

describe('activity feed', () => {
  it('keeps the event structured rather than a rendered sentence', () => {
    const parsed = activityFeedSchema.parse({
      data: [
        {
          id: 'e1',
          at: '2026-09-08T09:00:00.000Z',
          outcome: 'awaiting_approval',
          kind: 'refund.awaiting_approval',
          values: { amount: 179, currency: 'ILS' },
          subject: { type: 'order', id: '1842' },
          conversationId: 'c1',
        },
      ],
      nextCursor: null,
    });
    expect(parsed.data[0]?.values).toEqual({ amount: 179, currency: 'ILS' });
  });

  it('files an unmapped tool under its own slug instead of dropping the row', () => {
    const parsed = activityFeedSchema.parse({
      data: [
        {
          id: 'e2',
          at: '2026-09-08T09:00:00.000Z',
          outcome: 'completed',
          kind: 'add_contact_note.completed',
          values: {},
          subject: { type: 'unknown_thing', id: null },
        },
      ],
    });
    expect(parsed.data[0]?.kind).toBe('add_contact_note.completed');
    expect(parsed.data[0]?.subject.type).toBe('none');
  });
});

describe('time saved', () => {
  it('carries the basis, which the screen may not drop', () => {
    const parsed = timeSavedSchema.parse({
      secondsSaved: 3720,
      basis: {
        conversationsHandled: 60,
        secondsPerConversation: 62,
        source: 'platform_default',
        sampleSize: 0,
        method: 'platform_default',
        period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' },
      },
    });
    expect(parsed.basis?.source).toBe('platform_default');
  });
});

describe('in-flight', () => {
  it('keeps tools grouped by subject, which is what the sentence says', () => {
    const parsed = inFlightSchema.parse({
      conversationsHandling: 9,
      toolsRunning: [{ subject: 'order', count: 4 }],
      awaitingApproval: 3,
    });
    expect(parsed.toolsRunning[0]).toEqual({ subject: 'order', count: 4 });
  });

  it('reads an idle workspace as zeroes, not as a missing answer', () => {
    const parsed = inFlightSchema.parse({});
    expect(parsed.conversationsHandling).toBe(0);
    expect(parsed.toolsRunning).toEqual([]);
  });
});

describe('usage allowance', () => {
  /*
   * A tenant on an uncapped plan and one on no plan at all both answer null.
   * Coercing that to 0 would draw an empty meter and tell them they are out.
   */
  it('accepts a null limit, which means uncapped rather than nothing left', () => {
    const parsed = usageAllowanceSchema.parse({
      used: 1160,
      limit: null,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
      projectedExhaustionAt: null,
    });
    expect(parsed.limit).toBeNull();
    expect(parsed.projectedExhaustionAt).toBeNull();
  });
});

describe('insights', () => {
  it('parses the translatable shape', () => {
    const parsed = insightsSchema.parse([
      {
        id: 'top-intent-automation',
        kind: 'intent.automatable',
        values: { intent: 'SHIPPING_ISSUE', count: 43, days: 30 },
        impact: 'high',
        actionable: true,
      },
    ]);
    expect(parsed[0]?.values).toMatchObject({ count: 43 });
  });

  it('falls back on an impact grade it has not seen', () => {
    const parsed = insightsSchema.parse([
      { id: 'x', kind: 'something.new', values: {}, impact: 'critical', actionable: false },
    ]);
    expect(parsed[0]?.impact).toBe('medium');
  });
});
