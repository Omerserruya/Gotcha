import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Approval } from '@/api/contracts/approvals';

import messages from '@/i18n/messages/en/approvals.json';

import { KNOWN_RISK_TAGS } from '@/api/contracts/approvals';

import { ApprovalsScreen } from './ApprovalsScreen';

/**
 * The keyboard surface, tested rather than photographed.
 *
 * **This tenant has zero PENDING approvals**, so the queue, the decision and
 * the moment-after cannot appear in a capture at all — the acceptance evidence
 * covers 03c, which is the state the tenant is actually in. Seeding a pending
 * approval is not an option either: an ApprovalRequest is a bot-initiated
 * request to perform a real action, approving it moves real money, and there
 * is no create route because the only thing that makes one is the bot path.
 *
 * So these are the only place the keyboard model is checked, and they assert
 * behaviour rather than markup: what a key does, and — more importantly — what
 * it does not do.
 */

const { approve, reject } = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn() }));

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('./actions', () => ({
  approveRequest: approve,
  rejectRequest: reject,
  retryExecution: vi.fn(),
}));

const NOW = Date.parse('2026-09-19T10:00:00.000Z');

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  conversationId: 'c1',
  contactId: 'k1',
  tool: 'issue_refund',
  summary: 'Refund 179 for order 1842',
  reason: 'Arrived damaged',
  policyRuleName: null,
  riskLevel: 'medium',
  riskTags: [],
  status: 'PENDING',
  requestedBy: 'bot',
  requestedByName: null,
  decidedByName: null,
  decisionChannel: null,
  decidedAt: null,
  decisionReason: null,
  expiresAt: '2026-09-19T11:00:00.000Z',
  createdAt: '2026-09-19T09:00:00.000Z',
  executionState: 'NOT_STARTED',
  executionError: null,
  executionAttempts: 0,
  customerNotifiedAt: null,
  ...over,
});

function renderScreen(pending: readonly Approval[], decidedToday: number | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ approvals: messages }}>
      <ApprovalsScreen
        pending={pending}
        requesterNames={{}}
        serverNow={NOW}
        decidedToday={decidedToday}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  approve.mockReset().mockResolvedValue({ ok: true, dispatched: true });
  reject.mockReset().mockResolvedValue({ ok: true });
});

describe('A does not approve', () => {
  it('moves focus to Approve and decides nothing', async () => {
    // The design drew A as a single keypress that approves. It was drawn
    // assuming an Undo exists, and none does — anywhere in this platform.
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.keyboard('a');

    expect(screen.getByTestId('approve')).toHaveFocus();
    expect(approve).not.toHaveBeenCalled();
  });

  it('commits only on Enter, once focused', async () => {
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.keyboard('a');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledWith('a1');
  });

  it('applies the same rule to a row carrying no risk tags', async () => {
    // One rule, not two. A shortcut that behaves differently on some rows is
    // one nobody can hold in their head, and the queue's value is rhythm.
    const user = userEvent.setup();
    renderScreen([approval({ riskTags: ['IRREVERSIBLE', 'FINANCIAL'] })]);

    await user.keyboard('a');

    expect(screen.getByTestId('approve')).toHaveFocus();
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('shortcuts never fire from a text field', () => {
  it('types the letters instead of acting on them', async () => {
    // The rejection reason is on the same screen. "Rejected — arrived
    // damaged" firing R, E, A and D is not hypothetical.
    const user = userEvent.setup();
    renderScreen([approval()]);

    const field = screen.getByTestId('reject-reason');
    await user.click(field);
    await user.type(field, 'already handled');

    expect(field).toHaveValue('already handled');
    expect(approve).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
  });

  it('leaves the browser its modifier combinations', async () => {
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.keyboard('{Meta>}r{/Meta}');
    await user.keyboard('{Control>}a{/Control}');

    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByTestId('approve')).not.toHaveFocus();
  });
});

describe('R goes to the reason, because the route demands one', () => {
  it('focuses the reason field rather than rejecting', async () => {
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.keyboard('r');

    expect(screen.getByTestId('reject-reason')).toHaveFocus();
    expect(reject).not.toHaveBeenCalled();
  });

  it('refuses an empty reason without asking the server', async () => {
    reject.mockResolvedValue({ ok: false, reason: 'reason_required' });
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.click(screen.getByTestId('reject'));

    await waitFor(() =>
      expect(screen.getByTestId('approvals-announcement')).not.toBeEmptyDOMElement(),
    );
    expect(screen.getByTestId('reject-reason')).toHaveFocus();
  });
});

describe('arrow keys move selection and focus together', () => {
  it('advances to the next item', async () => {
    const user = userEvent.setup();
    renderScreen([approval(), approval({ id: 'a2', summary: 'Cancel order 4812' })]);

    await user.keyboard('{ArrowDown}');

    expect(screen.getByTestId('queue-a2')).toHaveFocus();
    expect(screen.getByTestId('queue-a2')).toHaveAttribute('aria-current', 'true');
  });

  it('stops at the ends rather than wrapping', async () => {
    const user = userEvent.setup();
    renderScreen([approval(), approval({ id: 'a2' })]);

    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('queue-a1')).toHaveAttribute('aria-current', 'true');
  });
});

describe('a lapsed row offers no decision', () => {
  const lapsed = approval({ expiresAt: '2026-09-19T09:30:00.000Z' });

  it('shows why instead of an Approve button', () => {
    // The route answers 409, and the countdown reaches zero while status is
    // still PENDING every time — the sweeper runs on a five-minute cron.
    renderScreen([lapsed]);

    expect(screen.queryByTestId('approve')).toBeNull();
    expect(screen.getByTestId('approval-lapsed')).toBeInTheDocument();
  });

  it('ignores A and R on it', async () => {
    const user = userEvent.setup();
    renderScreen([lapsed]);

    await user.keyboard('a');
    await user.keyboard('r');

    expect(approve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
});

describe('the moment after keeps the two axes apart', () => {
  it('says the action did not run when dispatch failed', async () => {
    approve.mockResolvedValue({
      ok: true,
      dispatched: false,
      dispatchError: 'shopify: refund window closed',
      approval: approval({ status: 'APPROVED', executionState: 'FAILED' }),
    });
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.click(screen.getByTestId('approve'));

    const panel = await screen.findByTestId('moment-after');
    expect(panel).toHaveAttribute('data-dispatched', 'no');
    expect(screen.getByTestId('moment-fact-execution')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId('moment-error')).toHaveTextContent('refund window closed');
  });

  it('does not claim the customer was told when nothing recorded it', async () => {
    approve.mockResolvedValue({
      ok: true,
      dispatched: true,
      approval: approval({ status: 'APPROVED', customerNotifiedAt: null }),
    });
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.click(screen.getByTestId('approve'));

    const customer = await screen.findByTestId('moment-fact-customer');
    // "Not yet" rather than "failed": delivery may still be retried, and
    // calling it a failure is a claim the data does not support.
    expect(customer).toHaveAttribute('data-state', 'pending');
  });

  it('offers retry only where the dispatch actually failed', async () => {
    approve.mockResolvedValue({
      ok: true,
      dispatched: true,
      approval: approval({ status: 'APPROVED', executionState: 'SUCCEEDED' }),
    });
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.click(screen.getByTestId('approve'));

    await screen.findByTestId('moment-after');
    expect(screen.queryByTestId('moment-retry')).toBeNull();
  });

  it('never offers retry on a row whose outcome was never recorded', async () => {
    approve.mockResolvedValue({
      ok: true,
      dispatched: true,
      approval: approval({ status: 'APPROVED', executionState: 'LEGACY_UNVERIFIED' }),
    });
    const user = userEvent.setup();
    renderScreen([approval()]);

    await user.click(screen.getByTestId('approve'));

    await screen.findByTestId('moment-after');
    expect(screen.queryByTestId('moment-retry')).toBeNull();
  });
});

describe('nothing on this screen promises a reversal', () => {
  it('renders IRREVERSIBLE as a label and no window anywhere', () => {
    renderScreen([approval({ riskTags: ['IRREVERSIBLE'] })]);

    expect(screen.getByTestId('risk-IRREVERSIBLE')).toBeInTheDocument();
    // "Reversible · Yes — within 24h" is read BEFORE the irreversible act.
    // It would make someone approve a refund they would otherwise question.
    expect(document.body.textContent).not.toMatch(/reversible|undo|take it back/i);
  });

  it('offers no way to edit what will run', () => {
    // The permission governing parameter edits is read by nobody, and this is
    // the one control that changes how much money moves.
    renderScreen([approval()]);

    expect(screen.queryByTestId('edit')).toBeNull();
    expect(document.body.textContent).not.toMatch(/edit amount/i);
  });
});

describe('★★ 28 rows in one column, given structure rather than pages', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * ★★ PAGINATION WAS ASKED FOR AND IS DELIBERATELY NOT HERE
   * ════════════════════════════════════════════════════════════════════════════
   * A browser walk found 28 rows unbroken and reported two things missing:
   * separators and paging. Only one belongs on a work queue.
   *
   * The oldest request is the one that most needs deciding and it sorts to the
   * far end. Behind a "show more", the item nobody has looked at becomes the item
   * nobody will look at — and `expiresAt` is real here, so a request that lapses
   * because it was on page two would be a defect we chose to build.
   *
   * These tests therefore assert BOTH: that the structure arrived, and that
   * nothing got hidden. The second is the one that would catch a future
   * well-meaning "improvement".
   */

  it('★★ shows every waiting request, with no page to turn', async () => {
    const many = Array.from({ length: 28 }, (_, i) =>
      approval({ id: `a${i}`, summary: `Refund ${i}` }),
    );
    renderScreen(many);
    expect(screen.getAllByTestId(/^queue-a\d+$/)).toHaveLength(28);
  });

  it('★★ says how many are waiting, as a number', async () => {
    renderScreen(Array.from({ length: 28 }, (_, i) => approval({ id: `a${i}` })));
    expect(screen.getByTestId('approval-queue-count')).toHaveTextContent('28 requests waiting');
  });

  it('★ counts one request without saying "1 requests"', async () => {
    renderScreen([approval()]);
    expect(screen.getByTestId('approval-queue-count')).toHaveTextContent('1 request waiting');
  });

  it('★★ heads each day, so age is legible without reading a timestamp', async () => {
    renderScreen([
      approval({ id: 'a1', createdAt: '2026-09-19T09:00:00.000Z' }),
      approval({ id: 'a2', createdAt: '2026-09-18T09:00:00.000Z' }),
      approval({ id: 'a3', createdAt: '2026-09-15T09:00:00.000Z' }),
    ]);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    /*
     * The third is neither, so it gets the date itself — asserted through its
     * group key rather than the formatted string. `Intl` decides whether `en`
     * medium reads "Sep 15, 2026" or "15 Sep 2026", and pinning one of those
     * would make this test a claim about a locale database.
     */
    const older = screen.getByTestId('queue-day-2026-9-15');
    expect(older).toBeInTheDocument();
    expect(older).toHaveTextContent('2026');
    expect(older.textContent).not.toMatch(/Today|Yesterday/);
  });

  it('★ a queue that is all today’s needs no heading — 02 draws none', async () => {
    renderScreen([
      approval({ id: 'a1', createdAt: '2026-09-19T09:00:00.000Z' }),
      approval({ id: 'a2', createdAt: '2026-09-19T08:00:00.000Z' }),
      approval({ id: 'a3', createdAt: '2026-09-19T07:00:00.000Z' }),
    ]);
    expect(screen.queryByText('Today')).toBeNull();
    expect(screen.getAllByTestId(/^queue-a\d+$/)).toHaveLength(3);
  });

  it('★★ but a queue all from ONE earlier day still says which day', async () => {
    renderScreen([
      approval({ id: 'a1', createdAt: '2026-09-18T09:00:00.000Z' }),
      approval({ id: 'a2', createdAt: '2026-09-18T08:00:00.000Z' }),
    ]);
    expect(screen.getAllByText('Yesterday')).toHaveLength(1);
  });

  it('★★ says a date was not recorded rather than calling it today', async () => {
    /*
     * The reassuring direction is the wrong one: an unreadable date labelled
     * "Today" puts an old request at the top of today's group and hides the one
     * thing these headings exist to surface.
     */
    renderScreen([approval({ id: 'a1', createdAt: 'not-a-date' })]);
    expect(screen.getByText('Date not recorded')).toBeInTheDocument();
    expect(screen.queryByText('Today')).toBeNull();
  });

  it('★★ never reorders the queue to tidy up the groups', async () => {
    /*
     * The server ranked this list. Re-sorting by date to avoid splitting a day
     * would silently reorder a decision queue, which is worse than a day
     * appearing twice — so the groups are cut in the order given, and this
     * asserts the order survives.
     */
    renderScreen([
      approval({ id: 'a1', createdAt: '2026-09-19T09:00:00.000Z' }),
      approval({ id: 'a2', createdAt: '2026-09-15T09:00:00.000Z' }),
      approval({ id: 'a3', createdAt: '2026-09-19T08:00:00.000Z' }),
    ]);
    const ids = screen.getAllByTestId(/^queue-a\d+$/).map((el) => el.getAttribute('data-id'));
    expect(ids).toEqual(['a1', 'a2', 'a3']);
    // And "Today" appears twice, because splitting it is the honest outcome.
    expect(screen.getAllByText('Today')).toHaveLength(2);
  });

  it('★★ keeps the keyboard walk working across a day boundary', async () => {
    /*
     * The separators are nested lists, so `move()` — which finds rows by
     * `data-id` — is unaffected by construction. Asserted anyway: "by
     * construction" is what I would have said about five other things this week.
     */
    const user = userEvent.setup();
    renderScreen([
      approval({ id: 'a1', createdAt: '2026-09-19T09:00:00.000Z' }),
      approval({ id: 'a2', createdAt: '2026-09-18T09:00:00.000Z' }),
    ]);
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('queue-a2')).toHaveFocus();
  });
});

describe('★★ 03, measured — what the new layout says', () => {
  it('★ a row shows how long it has waited', () => {
    renderScreen([approval()]);
    expect(screen.getByTestId('queue-a1')).toHaveTextContent('1h');
  });

  it('★★ and how long is LEFT, when the deadline is within the hour — 02’s "38m left"', () => {
    renderScreen([approval({ expiresAt: '2026-09-19T10:38:00.000Z' })]);
    expect(screen.getByTestId('queue-a1')).toHaveTextContent('38m left');
  });

  it('★ "If you leave it" names the real deadline', () => {
    renderScreen([approval({ expiresAt: '2026-09-19T11:00:00.000Z' })]);
    expect(screen.getByTestId('if-you-leave-it')).toHaveTextContent(
      /If nobody decides by \d{2}:\d{2}/,
    );
  });

  it('★ says how many come after this one', () => {
    renderScreen([approval({ id: 'a1' }), approval({ id: 'a2' }), approval({ id: 'a3' })]);
    expect(screen.getByTestId('next-hint')).toHaveTextContent('2 more after this · ↓ for the next');
  });

  it('⚠⚠ a one-tap reason FILLS the reason — it does not reject', async () => {
    renderScreen([approval()]);
    await userEvent.click(screen.getByTestId('reason-policy'));
    expect(screen.getByTestId('reject-reason')).toHaveValue('Outside policy');
    expect(reject).not.toHaveBeenCalled();
  });

  it('⚠ an unreadable date never throws the render — the eyebrow simply has no time', () => {
    renderScreen([approval({ createdAt: 'not-a-date' })]);
    expect(screen.getByTestId('requested-by')).toHaveTextContent('Requested by an automation');
  });
});

describe('★★ the supervisor’s three, against the test items', () => {
  it('⚠⚠ no tag reaches the screen as a raw code — MOVES_MONEY reads "Moves money"', () => {
    renderScreen([approval({ riskTags: ['MOVES_MONEY'] })]);
    expect(screen.getByTestId('queue-a1')).toHaveTextContent('Moves money');
    expect(screen.getByTestId('risk-MOVES_MONEY')).toHaveTextContent('Moves money');
    expect(document.body.textContent).not.toContain('MOVES_MONEY');
  });

  it('⚠⚠ a deadline on another day names the day — "by 13:02" read as today', () => {
    // NOW is Saturday 19 Sep 10:00 UTC; this expires Monday.
    renderScreen([approval({ expiresAt: '2026-09-21T13:02:00.000Z' })]);
    const card = screen.getByTestId('if-you-leave-it');
    expect(card).toHaveTextContent(/by Mon \d{2}:\d{2}/);
  });

  it('★ a deadline today stays a time', () => {
    renderScreen([approval({ expiresAt: '2026-09-19T11:00:00.000Z' })]);
    expect(screen.getByTestId('if-you-leave-it').textContent).not.toMatch(/Mon|Sun|Sep/);
  });

  it('★★ 02’s "Decided earlier today · N" leads to the history', () => {
    renderScreen([approval()], 7);
    const link = screen.getByTestId('decided-link');
    expect(link).toHaveTextContent('Decided earlier today');
    expect(link).toHaveTextContent('7');
    expect(link).toHaveAttribute('href', '/approvals?view=decided');
  });

  it('⚠ and no row when the history could not be read', () => {
    renderScreen([approval()], null);
    expect(screen.queryByTestId('decided-link')).toBeNull();
  });
});

describe('⚠⚠ every risk tag the platform writes has words', () => {
  it('★★ every tag the platform WRITES has a label — iterated, so a new one cannot slip by', async () => {
    const labels = (await import('@/i18n/messages/en/approvals.json')).default.risk as Record<
      string,
      string
    >;
    for (const tag of KNOWN_RISK_TAGS) {
      expect(labels[tag], tag).toBeTruthy();
      expect(labels[tag], tag).not.toMatch(/_|^[A-Z]+$/);
    }
  });
});
