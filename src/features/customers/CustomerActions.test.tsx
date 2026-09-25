import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  customerAuditSchema,
  outcomeOf,
  unrecordedHint,
  type AuditEvent,
} from '@/api/contracts/customer-actions';
import messages from '@/i18n/messages/en/customers.json';

import { CustomerActions } from './CustomerActions';
import type { AuditRead } from './load-customer';

/**
 * Screen 04e.
 *
 * ── WHAT A CAPTURE CAN AND CANNOT REACH ──
 * Everything here is reachable on the demo tenant EXCEPT `contradicts` and
 * the `unrecordedHint` branches, which no writer in the platform can
 * currently produce — see the last describe block, which says why rather
 * than leaving the gap to look like coverage.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: 'a1',
  actorType: 'ai',
  actorId: null,
  action: 'ai.responded',
  targetType: 'conversation',
  targetId: 'c1',
  createdAt: '2026-09-18T09:16:00.000Z',
  succeeded: null,
  nameImpliesSucceeded: null,
  outcomeDisagrees: false,
  ...over,
});

const ok = (
  events: AuditEvent[],
  over: Record<string, unknown> = {},
  supplied: readonly string[] = [],
): AuditRead => ({
  state: 'ok',
  supplied,
  audit: customerAuditSchema.parse({
    contact: { id: 'fixture-1', displayName: 'Avery Stone' },
    data: events,
    nextCursor: null,
    coverage: {},
    scope: { identities: 1, conversations: 1, conversationScanTruncated: false },
    ...over,
  }),
});

const show = async (actions: AuditRead) => render(await CustomerActions({ actions }));

describe('★★ four reads, because "not allowed" is not "broken"', () => {
  it('★★ a 403 asks for a permission; it does not report a fault', async () => {
    /*
     * The two send somebody to different places. "We couldn't read it" sends
     * them to check a system that is working perfectly; the truth sends them
     * to whoever grants permissions.
     */
    await show({ state: 'forbidden' });
    const panel = screen.getByTestId('customer-actions-forbidden');
    expect(panel).toHaveTextContent(/don't have permission/i);
    expect(panel).not.toHaveTextContent(/couldn't read/i);
  });

  it('a failed read says it is ours', async () => {
    await show({ state: 'failed' });
    expect(screen.getByTestId('customer-actions-failed')).toHaveTextContent(/couldn't read/i);
  });

  it('★ a read we never made renders nothing at all', async () => {
    /*
     * `not_asked` exists because the first version of this union returned
     * `failed` here while its own comment said that would report a request
     * that was never sent. The comment was right and the code was not.
     */
    const { container } = await show({ state: 'not_asked' });
    expect(container).toBeEmptyDOMElement();
  });

  it('★ an empty log is a fact about the customer, not a failure', async () => {
    // `data: []` from a successful read means nothing was done. It must not
    // share a sentence with either of the two failures above.
    await show(ok([]));
    expect(screen.getByTestId('actions-empty')).toHaveTextContent(/nothing has been recorded/i);
  });
});

describe('★★ the outcome column, and the name that never decides it', () => {
  it('★★ an executed commerce action still reads as UNRECORDED', async () => {
    /*
     * THE ROW THIS SCREEN IS HARDEST ON, and it is the common case:
     * `commerce-actions.service.ts` writes `commerce.customer_action_executed`
     * with metadata `{conversationId, correlationId, action, operationKey}`
     * and **no `ok`**. So nothing recorded whether it worked.
     *
     * The name says "executed". Letting it decide is exactly the defect
     * Backend caught in `outcomeOf`'s first version, so the screen shows the
     * name and states that the outcome was not recorded.
     */
    const row = event({ id: 'e1', action: 'commerce.customer_action_executed', actorType: 'user' });
    expect(outcomeOf(row)).toBe('not_recorded');
    await show(ok([row]));

    expect(screen.getByTestId('action-outcome-e1')).toHaveTextContent(/outcome not recorded/i);
    // And the name IS shown — a screen that hid it would drop the only
    // signal the row carries.
    expect(screen.getByTestId('action-e1')).toHaveTextContent(/sent to the store/i);
  });

  it('renders a recorded verdict as the verdict', async () => {
    await show(
      ok([
        event({ id: 'w', action: 'adapter.ok.shopify.get_customer_orders', succeeded: true }),
        event({ id: 'f', action: 'adapter.err.shopify.process_refund', succeeded: false }),
      ]),
    );
    expect(screen.getByTestId('action-outcome-w')).toHaveAttribute('data-outcome', 'worked');
    expect(screen.getByTestId('action-outcome-f')).toHaveAttribute('data-outcome', 'failed');
  });

  it('★ names the tool an adapter row acted through, rather than the raw action', async () => {
    await show(
      ok([event({ id: 't', action: 'adapter.ok.shopify.process_refund', succeeded: true })]),
    );
    expect(screen.getByTestId('action-t')).toHaveTextContent(/shopify\.process_refund/);
  });

  it('★ renders an action it has no words for VERBATIM', async () => {
    /*
     * An unknown event is still something that happened. Hiding it would
     * shorten somebody's record silently, which is the failure the coverage
     * declarations exist to prevent one level up.
     */
    await show(ok([event({ id: 'u', action: 'something.nobody.mapped' })]));
    expect(screen.getByTestId('action-u')).toHaveTextContent('something.nobody.mapped');
  });

  it('★ an unrecorded actor is named as unrecorded, not as the system', async () => {
    // `actorType` is nullable on the wire. Defaulting the blank to "system"
    // would attribute somebody's action to the platform.
    await show(ok([event({ id: 'n', actorType: null })]));
    expect(screen.getByTestId('action-who-n')).toHaveTextContent(/not recorded/i);
  });
});

describe('★★ what the log cannot account for', () => {
  const COVERAGE = {
    conversation: { attributable: true },
    customer: {
      attributable: true,
      requires: 'shopifyCustomerId',
      detail: 'Pass ?shopifyCustomerId= to include them.',
    },
    order: {
      attributable: false,
      reason: 'no_local_order_table',
      detail: 'There is no local Order table to enumerate this person’s orders from.',
    },
  };

  it('prints the endpoint’s own declaration rather than an empty list', async () => {
    await show(ok([event()], { coverage: COVERAGE }));
    expect(screen.getByTestId('actions-gap-order')).toHaveTextContent(/no local Order table/i);
  });

  it('★★ stops asking for a parameter it was given', async () => {
    /*
     * THE DEFECT `supplied` EXISTS FOR.
     *
     * `coverage` is a CONSTANT — the endpoint returns the same object
     * whether or not `?shopifyCustomerId=` was sent. Read as a report, the
     * screen prints "pass ?shopifyCustomerId= to include them" directly
     * underneath the rows that parameter fetched.
     */
    const { unmount } = await show(ok([event()], { coverage: COVERAGE }));
    expect(screen.getByTestId('actions-gap-customer')).toBeInTheDocument();
    unmount();

    await show(ok([event()], { coverage: COVERAGE }, ['shopifyCustomerId']));
    expect(screen.queryByTestId('actions-gap-customer')).toBeNull();
    // And the gap we did NOT satisfy is still there — this must narrow the
    // list, not silence it.
    expect(screen.getByTestId('actions-gap-order')).toBeInTheDocument();
  });

  it('★ discloses a bounded scan rather than quietly dropping the oldest', async () => {
    await show(
      ok([event()], {
        scope: { identities: 2, conversations: 900, conversationScanTruncated: true },
      }),
    );
    expect(screen.getByTestId('actions-truncated')).toHaveTextContent(/900 conversations/);
  });

  it('★ says older entries exist when the page is not the whole log', async () => {
    await show(ok([event()], { nextCursor: 'cur-1' }));
    expect(screen.getByTestId('actions-more')).toHaveTextContent(/older entries exist/i);
  });
});

describe('★★ two branches nothing in the platform can currently reach', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * NAMED, NOT LEFT TO LOOK LIKE COVERAGE.
   * ════════════════════════════════════════════════════════════════════════
   * `contradicts` needs `succeeded` and the action name to disagree.
   * `nameImpliesSucceeded` is non-null only for an action with an `ok.` or
   * `err.` segment, and the ONLY writer of one is `auditAdapterCall`, which
   * derives the name and `metadata.ok` from the same `opts.ok`. One
   * variable, two fields — they cannot differ.
   *
   * So on today's platform `outcomeDisagrees` is always false and
   * `unrecordedHint` always returns null. Both are kept because the contract
   * is the server's and a future emitter can produce them, and both are
   * DELIBERATELY absent from the capture fixture: a fabricated row would
   * photograph something this platform cannot do.
   */
  it('renders a contradicting row as its own state, if one ever arrives', async () => {
    const row = event({
      id: 'x',
      action: 'adapter.err.shopify.process_refund',
      succeeded: true,
      nameImpliesSucceeded: false,
      outcomeDisagrees: true,
    });
    await show(ok([row]));
    expect(screen.getByTestId('action-outcome-x')).toHaveAttribute('data-outcome', 'contradicts');
    expect(screen.getByTestId('action-outcome-x')).toHaveTextContent(/disagrees with itself/i);
  });

  it('shows the name as a hint where there is no verdict, if one ever arrives', async () => {
    const row = event({ id: 'h', succeeded: null, nameImpliesSucceeded: false });
    expect(unrecordedHint(row)).toBe('named_err');
    await show(ok([row]));
    expect(screen.getByTestId('action-hint-h')).toHaveTextContent(/never recorded/i);
  });
});
