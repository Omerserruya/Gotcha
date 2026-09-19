import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Approval } from '@/api/contracts/approvals';

import messages from '@/i18n/messages/en/approvals.json';

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

function renderScreen(pending: readonly Approval[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ approvals: messages }}>
      <ApprovalsScreen pending={pending} requesterNames={{}} serverNow={NOW} />
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
