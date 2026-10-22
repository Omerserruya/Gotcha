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
    /*
     * Capitalised, because `{action}` opens the `completed` and `failed`
     * sentences and follows a colon in `awaiting_approval`. This asserted
     * `'add contact note'` while the slug was de-snaked by hand here.
     */
    expect(message.values.action).toBe('Add contact note');
  });

  it('★ humanises the slug with the shared helper, brand map and all', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE HAND-ROLLED VERSION WAS `humaniseCode` MINUS THE MAPS
     * ════════════════════════════════════════════════════════════════════════
     * `noun.replace(/_/g, ' ')` gave "historical whatsapp import" on a product
     * that writes WhatsApp with two capitals on every other screen. It was not
     * a shortcut that needed refining; it was a second, worse copy of a
     * function that already existed two imports away.
     *
     * This is the assertion the old one could not make: it fails for any
     * implementation that splits on underscores without consulting the brand
     * map, which is precisely the code that was here.
     */
    expect(
      eventMessage(event({ kind: 'historical_whatsapp_import.completed' })).values.action,
    ).toBe('Historical WhatsApp import');
  });

  it('keeps the outcome on the fallback, so a failure still reads as one', () => {
    expect(eventMessage(event({ kind: 'sync_stock.failed' })).key).toBe('event.fallback.failed');
  });
});
