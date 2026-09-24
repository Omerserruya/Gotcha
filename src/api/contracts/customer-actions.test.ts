import { describe, expect, it } from 'vitest';

import {
  auditEventSchema,
  outcomeIsContradictory,
  outcomeOf,
  toolOf,
  type AuditEvent,
} from './customer-actions';

const event = (over: Partial<AuditEvent> = {}): AuditEvent =>
  auditEventSchema.parse({
    id: 'a1',
    actorType: 'ai',
    action: 'ai.responded',
    createdAt: '2026-09-24T10:00:00.000Z',
    ...over,
  });

describe('★★ three outcomes, because the platform records three', () => {
  it('never resolves an unrecorded verdict into a failure', () => {
    /*
     * The route's own comment: "null when the emitter recorded no verdict,
     * which is different from false: 'we did not record whether this worked'
     * is not 'it failed'."
     *
     * Rendered as failed it invents a failed refund; rendered as succeeded it
     * invents a completed one. Both are claims about a customer's money that
     * nobody made.
     */
    expect(outcomeOf(event({ succeeded: null }))).toBe('unknown');
    expect(outcomeOf(event({ succeeded: true }))).toBe('worked');
    expect(outcomeOf(event({ succeeded: false }))).toBe('failed');
  });

  it('falls back to the name prefix ONLY when there is no verdict', () => {
    // `adapter.err.*` and `adapter.ok.*` carry the outcome in the string.
    // Useful, and a convention rather than a record — so it is the fallback.
    expect(outcomeOf(event({ action: 'adapter.err.shopify.process_refund' }))).toBe('failed');
    expect(outcomeOf(event({ action: 'adapter.ok.shopify.get_order' }))).toBe('worked');
    expect(outcomeOf(event({ action: 'crm.link.linked' }))).toBe('unknown');
  });

  it('★ prefers the recorded verdict over the name, and says when they disagree', () => {
    /*
     * A row named `adapter.err.*` whose metadata says `ok: true` means the
     * emitter and its own name disagree about whether a customer's refund
     * happened. That is a defect somebody should see, not a rendering
     * preference to resolve quietly.
     */
    const contradictory = event({
      action: 'adapter.err.shopify.process_refund',
      succeeded: true,
    });
    expect(outcomeOf(contradictory)).toBe('worked');
    expect(outcomeIsContradictory(contradictory)).toBe(true);

    // And agreement is not a contradiction.
    expect(
      outcomeIsContradictory(event({ action: 'adapter.err.shopify.x', succeeded: false })),
    ).toBe(false);
    // Nor is an unrecorded verdict: nothing to disagree with.
    expect(
      outcomeIsContradictory(event({ action: 'adapter.err.shopify.x', succeeded: null })),
    ).toBe(false);
  });

  it('names the tool an adapter row acted through', () => {
    expect(toolOf(event({ action: 'adapter.ok.shopify.get_customer_orders' }))).toBe(
      'shopify.get_customer_orders',
    );
    // And nothing for a row that is not an adapter call.
    expect(toolOf(event({ action: 'ai.responded' }))).toBeNull();
  });
});

describe('★ the shape is the platform’s, including what it will not promote', () => {
  it('keeps targetId as the CONVERSATION, not the thing acted on', () => {
    /*
     * The route says so itself: the order id lives in `metadata.args` and
     * "has no general shape across tools", so it is deliberately not
     * promoted to a field. A screen rendering targetId as "the order" would
     * name the wrong object with complete confidence.
     */
    const row = event({ targetType: 'conversation', targetId: 'conv-1' });
    expect(row.targetType).toBe('conversation');
    expect(row.targetId).toBe('conv-1');
  });

  it('★ has no `flow` actor, because the column does not', () => {
    // The design asks for AI, user and flow. The column is user|ai|system,
    // so a flow-driven action arrives as one of those three and the
    // distinction cannot be made — named on screen rather than approximated.
    expect(() => auditEventSchema.parse({ ...event(), actorType: 'flow' })).toThrow();
  });
});
