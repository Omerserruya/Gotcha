import { describe, expect, it } from 'vitest';

import {
  auditEventSchema,
  coverageGaps,
  customerAuditSchema,
  outcomeOf,
  toolOf,
  unrecordedHint,
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

describe('★★ four outcomes, and the NAME never decides', () => {
  it('★★ an unrecorded verdict stays unrecorded, whatever the action is called', async () => {
    /*
     * THE DEFECT THIS FILE'S FIRST VERSION SHIPPED.
     *
     * `outcomeOf` used to fall back to the `adapter.err.` prefix when
     * `succeeded` was null - and described that in its own comment as
     * preserving "unknown". It did not. **A fallback IS resolution by naming
     * convention**, which the same sentence said not to do.
     *
     * So a row with no recorded verdict and `err` in its name came out as
     * `failed`: "nobody wrote down whether this refund happened" rendered as
     * "this refund failed". A claim about a customer's money that nobody made.
     */
    expect(outcomeOf(event({ succeeded: null, nameImpliesSucceeded: false }))).toBe('not_recorded');
    expect(outcomeOf(event({ succeeded: null, nameImpliesSucceeded: true }))).toBe('not_recorded');
    expect(outcomeOf(event({ succeeded: null, nameImpliesSucceeded: null }))).toBe('not_recorded');
  });

  it('reports the verdict where there is one', () => {
    expect(outcomeOf(event({ succeeded: true }))).toBe('worked');
    expect(outcomeOf(event({ succeeded: false }))).toBe('failed');
  });

  it('★★ a contradiction is its own state, not a value to smooth', () => {
    /*
     * A row that says a refund both worked and did not is a defect in the
     * emitter. Rendered as either answer it disappears; rendered as its own
     * state somebody can see it.
     */
    const row = event({
      action: 'adapter.err.shopify.process_refund',
      succeeded: true,
      nameImpliesSucceeded: false,
      outcomeDisagrees: true,
    });
    expect(outcomeOf(row)).toBe('contradicts');
  });

  it('★ the name is shown as a HINT, and only where there is no verdict', () => {
    /*
     * On an unrecorded row the name is the only signal there is, and saying
     * "named as a failure, though the outcome was never recorded" informs
     * without asserting. That is a different act from resolving the state
     * with it.
     */
    expect(unrecordedHint(event({ succeeded: null, nameImpliesSucceeded: false }))).toBe(
      'named_err',
    );
    expect(unrecordedHint(event({ succeeded: null, nameImpliesSucceeded: true }))).toBe('named_ok');
    // Nothing to hint at when the outcome IS recorded - the verdict speaks.
    expect(unrecordedHint(event({ succeeded: false, nameImpliesSucceeded: false }))).toBeNull();
    expect(unrecordedHint(event({ succeeded: null, nameImpliesSucceeded: null }))).toBeNull();
  });

  it('names the tool an adapter row acted through', () => {
    expect(toolOf(event({ action: 'adapter.ok.shopify.get_customer_orders' }))).toBe(
      'shopify.get_customer_orders',
    );
    expect(toolOf(event({ action: 'ai.responded' }))).toBeNull();
  });
});

/**
 * A body the route could actually send.
 *
 * ★ THESE FIXTURES USED TO BE PARTIAL AND PARSED ANYWAY, because every key
 * at this level carried a default. `{}` was a valid `CustomerAudit`, which
 * meant a stale or renamed response rendered as "nothing has been recorded
 * against this person" with no caveats - a confident claim about somebody's
 * history built from a response that said nothing.
 *
 * The defaults are gone, and these had to be completed to keep passing. That
 * is the point: a fixture is a claim that the platform can produce these
 * values, and three of them here could not.
 */
const envelope = (over: Record<string, unknown> = {}) => ({
  contact: { id: 'c1', displayName: 'Avery Stone' },
  data: [],
  nextCursor: null,
  coverage: { conversation: { attributable: true } },
  scope: { identities: 1, conversations: 1, conversationScanTruncated: false },
  ...over,
});

describe('★★ coverage declares what the log cannot account for', () => {
  it('lists orders as a gap, and customer rows as a gap until the id is passed', () => {
    /*
     * `targetId` on a customer-keyed row is a SHOPIFY customer id, not a
     * Contact id, so the endpoint cannot derive it. Order rows cannot be
     * attributed at all - same id space, no local Order table.
     *
     * An empty list cannot say why it is empty, and "no orders" is the wrong
     * thing for a screen to imply about somebody who may have many.
     */
    const parsed = customerAuditSchema.parse(
      envelope({
        coverage: {
          conversation: { attributable: true },
          customer: {
            attributable: true,
            requires: 'shopifyCustomerId',
            detail: 'Pass ?shopifyCustomerId= to include them.',
          },
          order: {
            attributable: false,
            reason: 'no_local_order_table',
            detail: "There is no local order table to enumerate this person's orders from.",
          },
        },
      }),
    );
    const gaps = coverageGaps(parsed.coverage);
    expect(gaps.map((g) => g.target).sort()).toEqual(['customer', 'order']);
    // Both kinds together: to a merchant they are the same fact.
    expect(gaps.find((g) => g.target === 'customer')?.detail).toMatch(/shopifyCustomerId/);
  });

  it('a fully attributable source is not a gap', () => {
    const parsed = customerAuditSchema.parse(
      envelope({ coverage: { conversation: { attributable: true } } }),
    );
    expect(coverageGaps(parsed.coverage)).toHaveLength(0);
  });

  it('★ discloses the conversation-scan bound', () => {
    // A bounded read that says so is fine; one that quietly drops the oldest
    // conversations is the defect.
    const parsed = customerAuditSchema.parse(
      envelope({ scope: { identities: 3, conversations: 500, conversationScanTruncated: true } }),
    );
    expect(parsed.scope.conversationScanTruncated).toBe(true);
    expect(parsed.scope.identities).toBe(3);
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
    // distinction cannot be made - named on screen rather than approximated.
    expect(() => auditEventSchema.parse({ ...event(), actorType: 'flow' })).toThrow();
  });

  it('★★ refuses a body that is missing what the route always sends', () => {
    /*
     * The screen this guards: `{}` used to parse, and rendered "nothing has
     * been recorded against this person yet" with no coverage caveats
     * underneath - from a response that carried no rows and no declarations.
     * A stale service produces exactly that body.
     */
    expect(() => customerAuditSchema.parse({})).toThrow();
    const { coverage: _c, ...noCoverage } = envelope();
    expect(() => customerAuditSchema.parse(noCoverage)).toThrow();
    const { scope: _s, ...noScope } = envelope();
    expect(() => customerAuditSchema.parse(noScope)).toThrow();
    // And the complete body still parses, so this is a floor and not a wall.
    expect(customerAuditSchema.parse(envelope()).contact?.id).toBe('c1');
  });
});
