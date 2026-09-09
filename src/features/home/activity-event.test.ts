import { describe, expect, it } from 'vitest';

import type { ActivityEvent } from '@/api/contracts/analytics';

import { ABSENT, eventMessage, splitKind } from './activity-event';

const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: 'e1',
  at: '2026-09-08T08:12:00.000Z',
  outcome: 'completed',
  kind: 'refund.completed',
  values: {},
  subject: { type: 'order', id: '1842' },
  conversationId: 'c1',
  ...overrides,
});

describe('splitKind', () => {
  it('splits on the last dot, so a dotted tool slug keeps its outcome', () => {
    expect(splitKind('refund.completed')).toEqual(['refund', 'completed']);
    expect(splitKind('vendor.sync_stock.failed')).toEqual(['vendor.sync_stock', 'failed']);
  });

  it('treats a bare kind as completed rather than producing a missing key', () => {
    expect(splitKind('refund')).toEqual(['refund', 'completed']);
  });
});

describe('eventMessage', () => {
  it('uses the mapped wording for a known noun', () => {
    expect(eventMessage(event()).key).toBe('event.refund.completed');
  });

  it('carries the customer and the human-facing subject id', () => {
    const { values } = eventMessage(
      event({ values: { customerName: 'Dana Cohen' }, subject: { type: 'order', id: '1842' } }),
    );
    expect(values.customer).toBe('Dana Cohen');
    expect(values.subject).toBe('#1842');
  });

  /*
   * The blanks the server did not fill must be a token the message can select
   * on. An empty string would leave "Refunded ₪179 to " on the card.
   */
  it('marks an absent value rather than leaving a dangling clause', () => {
    const { values } = eventMessage(event({ values: {}, subject: { type: 'none', id: null } }));
    expect(values.customer).toBe(ABSENT);
    expect(values.subject).toBe(ABSENT);
  });

  it('falls back to the tool slug for a tool nobody mapped', () => {
    const message = eventMessage(event({ kind: 'add_contact_note.completed' }));
    expect(message.key).toBe('event.fallback.completed');
    expect(message.values.action).toBe('add contact note');
  });

  it('keeps the outcome on the fallback, so a failure still reads as one', () => {
    expect(eventMessage(event({ kind: 'sync_stock.failed' })).key).toBe('event.fallback.failed');
  });
});
