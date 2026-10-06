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

import { approvalSchema } from '@/api/contracts/approvals';
import { businessPoliciesSchema } from '@/api/contracts/business-policies';

import {
  ActionFilters,
  ActionsSide,
  CustomerActions,
  expectsOutcome,
  humanReason,
  parseActionFilter,
} from './CustomerActions';
import type { AuditRead } from './load-customer';

/**
 * Screen 04e.
 *
 * ── WHAT A CAPTURE CAN AND CANNOT REACH ──
 * Everything here is reachable on the demo tenant EXCEPT `contradicts` and
 * the `unrecordedHint` branches, which no writer in the platform can
 * currently produce - see the last describe block, which says why rather
 * than leaving the gap to look like coverage.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}?${new URLSearchParams(href.query ?? {})}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));
/* The decision controls are a client component with their own test. */
vi.mock('./DecideHere', () => ({
  DecideHere: ({ approvalId }: { approvalId: string }) => (
    <span data-testid={`decide-here-${approvalId}`} />
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: 'a1',
  actorType: 'ai',
  actorId: null,
  // A tool GOTCHA used: an action on the account, with an outcome to report.
  // (A reply is the conversation, and collapses - see its own tests.)
  action: 'ai.tool_call.lookup_order',
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
    // And the name IS shown - a screen that hid it would drop the only
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

  it('★ an action it has no words for is KEPT - in words, with the key as its tooltip', async () => {
    /*
     * An unknown event is still something that happened. Hiding it would
     * shorten somebody's record silently, which is the failure the coverage
     * declarations exist to prevent one level up.
     *
     * ★ SUPERSEDED "VERBATIM" (2026-10-02): no code reaches the screen raw.
     * `something.nobody_mapped` reads as words, and whoever is debugging
     * finds the key on hover.
     */
    await show(ok([event({ id: 'u', action: 'something.nobody_mapped' })]));
    const row = screen.getByTestId('action-u');
    expect(row).toHaveTextContent('Something nobody mapped');
    expect(row).not.toHaveTextContent('something.nobody_mapped');
    expect(row.querySelector('[title="something.nobody_mapped"]')).not.toBeNull();
  });

  it('★★ GOTCHA’s guards are said as what they do - a claim flagged is not a claim stopped', async () => {
    /*
     * `ai.unsupported_outcome_claim` strips the claim only when the reply can
     * be cleaned; otherwise the reply goes out as written. So the sentence
     * is that the reply CLAIMED it - never that GOTCHA was stopped.
     */
    await show(
      ok([
        event({ id: 'o', action: 'ai.unsupported_outcome_claim' }),
        event({ id: 'a', action: 'ai.unsupported_action_claim' }),
        event({ id: 'x', actorType: 'system', action: 'ai.exit_criteria_blocked' }),
        event({ id: 'v', actorType: 'system', action: 'ai.output_validator.blocked' }),
      ]),
    );
    expect(screen.getByTestId('action-o')).toHaveTextContent(
      "GOTCHA's reply claimed something no tool had done",
    );
    expect(screen.getByTestId('action-o')).not.toHaveTextContent(/stopped/i);
    expect(screen.getByTestId('action-a')).toHaveTextContent(
      "said it was doing something it wasn't",
    );
    expect(screen.getByTestId('action-x')).toHaveTextContent(
      'details it needed were still missing',
    );
    expect(screen.getByTestId('action-v')).toHaveTextContent('replaced before it went out');
    // Known keys carry no tooltip: the words are ours by design, not a guess.
    expect(screen.getByTestId('action-o').querySelector('[title]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/ai\.[a-z_.]+/);
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
     * `coverage` is a CONSTANT - the endpoint returns the same object
     * whether or not `?shopifyCustomerId=` was sent. Read as a report, the
     * screen prints "pass ?shopifyCustomerId= to include them" directly
     * underneath the rows that parameter fetched.
     */
    const { unmount } = await show(ok([event()], { coverage: COVERAGE }));
    expect(screen.getByTestId('actions-gap-customer')).toBeInTheDocument();
    unmount();

    await show(ok([event()], { coverage: COVERAGE }, ['shopifyCustomerId']));
    expect(screen.queryByTestId('actions-gap-customer')).toBeNull();
    // And the gap we did NOT satisfy is still there - this must narrow the
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
   * variable, two fields - they cannot differ.
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

const approval = (over: Record<string, unknown> = {}) =>
  approvalSchema.parse({
    id: 'p1',
    conversationId: 'c1',
    tool: 'shopify.process_refund',
    summary: 'Process refund of 179 for order #1842',
    reason: 'The box arrived damaged in her photo.',
    status: 'PENDING',
    requestedBy: 'bot',
    expiresAt: '2026-09-19T09:00:00.000Z',
    createdAt: '2026-09-18T09:31:00.000Z',
    ...over,
  });

describe('★★ 04e - one spine: what was done, and what GOTCHA asked for', () => {
  it('★★ a waiting approval: the sentence, "Waiting on you", the reasoning, and where to decide', async () => {
    render(await CustomerActions({ actions: ok([event()]), approvals: [approval()] }));
    const row = screen.getByTestId('action-approval-p1');
    expect(row).toHaveTextContent('Process refund of 179 for order #1842');
    expect(row).toHaveTextContent('Waiting on you');
    expect(row).toHaveTextContent('The box arrived damaged in her photo.');
    // 02: decided on the row (Approve · Decline · Change amount).
    expect(row.querySelector('[data-testid^="decide-here-"]')).not.toBeNull();
    // No decision control is drawn here: deciding is 03's.
    expect(row.querySelector('button')).toBeNull();
  });

  it('a decided one says how it was decided, with no link', async () => {
    render(
      await CustomerActions({ actions: ok([]), approvals: [approval({ status: 'APPROVED' })] }),
    );
    const row = screen.getByTestId('action-approval-p1');
    expect(row).toHaveTextContent('Approved');
    expect(row.querySelector('a')).toBeNull();
  });

  it('★ both records in one order, newest first', async () => {
    render(
      await CustomerActions({
        actions: ok([
          event({ id: 'old', createdAt: '2026-09-01T09:00:00.000Z' }),
          event({ id: 'new', createdAt: '2026-09-20T09:00:00.000Z' }),
        ]),
        approvals: [approval({ createdAt: '2026-09-10T09:00:00.000Z' })],
      }),
    );
    const ids = [...document.querySelectorAll('li[data-testid]')].map((li) =>
      li.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['action-new', 'action-approval-p1', 'action-old']);
  });

  it('★ who: GOTCHA as "AI", a flow’s request as an automation', async () => {
    render(
      await CustomerActions({
        actions: ok([]),
        approvals: [approval({ id: 'f', requestedBy: 'flow:abc' })],
      }),
    );
    expect(screen.getByTestId('action-approval-f').querySelector('[data-who]')).toHaveAttribute(
      'data-who',
      'flow',
    );
  });
});

describe('★ 04e’s filters: All, GOTCHA, Team, Money', () => {
  const events = [
    event({ id: 'ai', actorType: 'ai', action: 'ai.tool_call.lookup_order' }),
    event({ id: 'team', actorType: 'user', action: 'shopify_live_chat.product_message_sent' }),
    event({ id: 'shop', actorType: 'user', action: 'commerce.customer_action_executed' }),
    // Neither GOTCHA nor a person: the system, and an actor nobody recorded.
    event({ id: 'sys', actorType: 'system', action: 'security.cross_customer_access_denied' }),
    event({ id: 'nobody', actorType: null, action: 'ai.paused_for_approval' }),
  ];
  const ids = () =>
    [...document.querySelectorAll('li[data-testid]')].map((li) => li.getAttribute('data-testid'));

  it('GOTCHA: its own actions and what it asked for', async () => {
    render(
      await CustomerActions({
        actions: ok(events),
        approvals: [approval(), approval({ id: 'flowed', requestedBy: 'flow:x' })],
        filter: 'gotcha',
      }),
    );
    // Not the system, not an automation's request, not an unrecorded actor.
    expect(ids().sort()).toEqual(['action-ai', 'action-approval-p1']);
  });

  it('Team: what a person did', async () => {
    render(await CustomerActions({ actions: ok(events), approvals: [approval()], filter: 'team' }));
    expect(ids().sort()).toEqual(['action-shop', 'action-team']);
  });

  it('Money: refunds, cancels and the customer’s record in the store', async () => {
    render(
      await CustomerActions({ actions: ok(events), approvals: [approval()], filter: 'money' }),
    );
    expect(ids().sort()).toEqual(['action-approval-p1', 'action-shop']);
  });

  it('⚠ a filter that keeps nothing says so - not the empty-log sentence', async () => {
    render(await CustomerActions({ actions: ok([events[0]!]), approvals: [], filter: 'team' }));
    expect(screen.getByTestId('actions-empty')).toHaveTextContent('Nothing here.');
  });

  it('the links, and an unknown filter is All', async () => {
    render(await ActionFilters({ contactId: 'k1', current: 'money' }));
    expect(screen.getByTestId('action-filter-money')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('action-filter-team')).toHaveAttribute(
      'href',
      '/customers/k1?tab=actions&filter=team',
    );
    expect(parseActionFilter('team')).toBe('team');
    expect(parseActionFilter('x')).toBe('all');
  });
});

describe('★★ 04e’s side - counts of what was read, "-" for what was not', () => {
  it('who did what, what waits on money, where to change what GOTCHA may do', async () => {
    render(
      await ActionsSide({
        actions: ok([
          event({ id: 'a', actorType: 'ai' }),
          event({ id: 'b', actorType: 'user' }),
          event({ id: 'c', actorType: 'system' }),
        ]),
        approvals: [approval(), approval({ id: 'f', requestedBy: 'flow:x', status: 'APPROVED' })],
      }),
    );
    const who = screen.getByTestId('actions-who');
    expect(who).toHaveTextContent('by GOTCHA2');
    expect(who).toHaveTextContent('by your team1');
    expect(who).toHaveTextContent('by automations2');
    const money = screen.getByTestId('actions-money');
    expect(money).toHaveTextContent('Waiting on approval1 request');
    expect(money).toHaveTextContent('Refunded-');
    expect(screen.getByTestId('actions-may').querySelector('a')).toHaveAttribute(
      'href',
      '/studio/capabilities',
    );
    expect(screen.getByTestId('promise-card')).toBeInTheDocument();
  });

  it('★★ "by GOTCHA" is the orchestrator’s count when the timeline was read (4b7c2e1b)', async () => {
    // The audit log never saw a Shopify store's lookups and refunds: 14 against 116.
    render(
      await ActionsSide({
        actions: ok([event({ id: 'a', actorType: 'ai' })]),
        approvals: [],
        aiActions: 116,
      }),
    );
    expect(screen.getByTestId('actions-who')).toHaveTextContent('by GOTCHA116');
  });

  it('⚠ unread records are "-", never 0', async () => {
    render(await ActionsSide({ actions: { state: 'failed' }, approvals: null }));
    expect(screen.getByTestId('actions-who').textContent?.match(/-/g)).toHaveLength(3);
    expect(screen.getByTestId('actions-money')).toHaveTextContent('Waiting on approval-');
  });
});

describe('★★ the conversation is not an action on the account (measured: drowned in replies)', () => {
  const day = (h: number) => `2026-09-18T${String(h).padStart(2, '0')}:00:00.000Z`;

  it('★★ a day of replies is one row - "GOTCHA replied 3 times" - with no outcome chip', async () => {
    render(
      await CustomerActions({
        actions: ok([
          event({ id: 'r1', action: 'ai.responded', createdAt: day(9) }),
          event({ id: 'r2', action: 'ai.responded', createdAt: day(10) }),
          event({ id: 'r3', action: 'ai.responded', createdAt: day(11) }),
          event({ id: 't1', action: 'ai.bot_turn', createdAt: day(11) }),
        ]),
      }),
    );
    const rows = screen.getAllByTestId(/^action-day-replied-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('GOTCHA replied 3 times');
    expect(rows[0]!.querySelector('[data-outcome]')).toBeNull();
    expect(screen.queryByTestId('action-r1')).toBeNull();
  });

  it('two days are two rows; the team’s messages are their own', async () => {
    render(
      await CustomerActions({
        actions: ok([
          event({ id: 'a', action: 'ai.responded', createdAt: '2026-09-17T10:00:00.000Z' }),
          event({ id: 'b', action: 'ai.responded', createdAt: '2026-09-18T10:00:00.000Z' }),
          event({ id: 'c', actorType: 'user', action: 'message.sent', createdAt: day(12) }),
          event({ id: 'd', actorType: 'user', action: 'message.sent', createdAt: day(13) }),
        ]),
      }),
    );
    expect(screen.getAllByTestId(/^action-day-replied-/)).toHaveLength(2);
    expect(screen.getByTestId(/^action-day-sent-/)).toHaveTextContent('Your team sent 2 messages');
  });

  it('⚠ a day of turns with no recorded reply still counts - never a silent zero', async () => {
    render(
      await CustomerActions({
        actions: ok([
          event({ id: 't1', action: 'ai.bot_turn', createdAt: day(9) }),
          event({ id: 't2', action: 'ai.bot_turn', createdAt: day(10) }),
        ]),
      }),
    );
    expect(screen.getByTestId(/^action-day-replied-/)).toHaveTextContent('GOTCHA replied 2 times');
  });

  it('★★ and replies are not counted as things GOTCHA did', async () => {
    render(
      await ActionsSide({
        actions: ok([
          event({ id: 'r1', action: 'ai.responded' }),
          event({ id: 'r2', action: 'ai.bot_turn' }),
          event({ id: 'x', action: 'ai.tool_call.lookup_order' }),
        ]),
        approvals: [],
      }),
    );
    expect(screen.getByTestId('actions-who')).toHaveTextContent('by GOTCHA1');
  });
});

describe('★★ no internal key reaches the screen', () => {
  it('★ the budget stop says which budget, in words - not "tenant_day"', async () => {
    render(
      await CustomerActions({
        actions: ok([
          event({ id: 'b', action: 'ai.budget.aborted.tenant_day' }),
          event({ id: 'c', action: 'ai.budget.aborted.conversation' }),
          event({ id: 'z', action: 'ai.budget.aborted.weekly_cap' }),
        ]),
      }),
    );
    expect(screen.getByTestId('action-b')).toHaveTextContent(
      "GOTCHA paused: the workspace's daily AI budget ran out",
    );
    expect(screen.getByTestId('action-c')).toHaveTextContent("this conversation's AI budget");
    // A scope the platform adds later: still words, never the key.
    expect(screen.getByTestId('action-z')).toHaveTextContent('GOTCHA paused: an AI budget ran out');
    expect(document.body.textContent).not.toMatch(/tenant_day|weekly_cap/);
  });

  it('★ a tool GOTCHA used is named legibly', async () => {
    render(
      await CustomerActions({
        actions: ok([event({ id: 't', action: 'ai.tool_call.shopify.lookup_order' })]),
      }),
    );
    expect(screen.getByTestId('action-t')).toHaveTextContent('GOTCHA used Lookup order');
    expect(screen.getByTestId('action-t')).not.toHaveTextContent('shopify.lookup_order');
  });

  it('★★ a policy log line is not a reason: "catalog=always" leaves the line empty', async () => {
    expect(humanReason('policy requires approval (catalog=always)')).toBeNull();
    expect(humanReason('limit=100 exceeded')).toBeNull();
    expect(humanReason('  ')).toBeNull();
    expect(humanReason('The box arrived damaged in her photo.')).toBe(
      'The box arrived damaged in her photo.',
    );
    render(
      await CustomerActions({
        actions: ok([]),
        approvals: [approval({ reason: 'policy requires approval (catalog=always)' })],
      }),
    );
    expect(screen.getByTestId('action-approval-p1')).not.toHaveTextContent('catalog');
  });
});

describe('★ the outcome chip only where an outcome is expected', () => {
  it('a tool, an adapter call and a store action carry one', () => {
    expect(expectsOutcome(event({ action: 'ai.tool_call.lookup_order' }))).toBe(true);
    expect(expectsOutcome(event({ action: 'adapter.ok.shopify.get_customer_orders' }))).toBe(true);
    expect(expectsOutcome(event({ action: 'commerce.customer_action_executed' }))).toBe(true);
  });

  it('⚠ a pause, a refusal and a budget stop ARE the outcome - no chip', async () => {
    render(
      await CustomerActions({
        actions: ok([
          event({ id: 'p', action: 'ai.paused_for_approval' }),
          event({ id: 's', actorType: 'system', action: 'security.cross_customer_access_denied' }),
          event({ id: 'b', action: 'ai.budget.aborted.turn' }),
        ]),
      }),
    );
    for (const id of ['p', 's', 'b']) {
      expect(screen.getByTestId(`action-${id}`).querySelector('[data-outcome]')).toBeNull();
    }
  });

  it('★ but a recorded verdict is shown wherever it exists', async () => {
    render(
      await CustomerActions({
        actions: ok([event({ id: 'v', action: 'ai.paused_for_approval', succeeded: false })]),
      }),
    );
    expect(screen.getByTestId('action-outcome-v')).toHaveAttribute('data-outcome', 'failed');
  });
});

describe('★★ What GOTCHA may do - the tenant’s rules, in words', () => {
  const policies = businessPoliciesSchema.parse({
    actionKinds: ['REFUND', 'CANCEL_ORDER', 'DISCOUNT', 'CUSTOMER_WRITE', 'COUPON'],
    policies: [
      { actionKind: 'REFUND', config: { maxAmount: 300, managerApprovalAboveAmount: 100 } },
      { actionKind: 'CANCEL_ORDER', enabled: false },
      { actionKind: 'COUPON', config: { maxPercentOfOrder: 0.1 } },
    ],
  });

  it('★ each kind as one sentence, amounts in the shop’s currency', async () => {
    render(await ActionsSide({ actions: ok([]), approvals: [], policies, currency: 'ILS' }));
    expect(screen.getByTestId('policy-REFUND')).toHaveTextContent(
      /^Refunds: up to ₪300(\.00)?; a person approves above ₪100(\.00)?\.$/,
    );
    expect(screen.getByTestId('policy-CANCEL_ORDER')).toHaveTextContent(
      'Cancelling an order: never - switched off.',
    );
    expect(screen.getByTestId('policy-DISCOUNT')).toHaveTextContent(
      'Discounts: never - no rule set.',
    );
    expect(screen.getByTestId('policy-CUSTOMER_WRITE')).toHaveTextContent(
      'Changes to their record: no rule set.',
    );
    // The engine's percent is a fraction of the order.
    expect(screen.getByTestId('policy-COUPON')).toHaveTextContent(
      'Coupons: up to 10% of the order.',
    );
  });

  it('⚠ no sentence claims GOTCHA acts "on its own" - the tool catalog may still ask', async () => {
    render(await ActionsSide({ actions: ok([]), approvals: [], policies, currency: 'ILS' }));
    expect(screen.getByTestId('actions-policies')).not.toHaveTextContent(/on its own/i);
  });

  it('without a currency, amounts are plain numbers - no symbol invented', async () => {
    render(await ActionsSide({ actions: ok([]), approvals: [], policies }));
    expect(screen.getByTestId('policy-REFUND')).toHaveTextContent('Refunds: up to 300;');
  });

  it('⚠ unread, or not readable by this viewer: "-", with the place to change them', async () => {
    render(await ActionsSide({ actions: ok([]), approvals: [], policies: null }));
    expect(screen.getByTestId('actions-may')).toHaveTextContent('-');
    expect(screen.queryByTestId('actions-policies')).toBeNull();
  });
});
