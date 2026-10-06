import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Approval } from '@/api/contracts/approvals';
import messages from '@/i18n/messages/en/approvals.json';

import type { ApprovalCustomer } from './approval-customers';

const { approve, reject } = vi.hoisted(() => ({ approve: vi.fn(), reject: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./actions', () => ({
  approveRequest: approve,
  rejectRequest: reject,
  retryExecution: vi.fn(),
}));

import { ApprovalsScreen } from './ApprovalsScreen';
import { editedValueProblem, reversibilityOf, whyBullets } from './request-words';

const NOW = Date.parse('2026-10-04T10:00:00.000Z');
/** Dev's mock request, as the supervisor seeded it: a contact, no conversation. */
const refund = (over: Partial<Approval> = {}): Approval => ({
  editedAmount: null,
  editedPercentage: null,
  facts: {
    order: '#TEST-1842',
    amount: 179,
    currency: 'ILS',
    note: 'damaged item · full refund recommended',
    percentage: null,
  },
  id: 'a1',
  conversationId: null,
  contactId: 'k1',
  tool: 'shopify.process_refund',
  summary: 'Process refund of 179 for order #TEST-1842',
  reason:
    'Delivered 4 days ago, marked damaged on arrival. Customer sent a photo. Third contact about this order.',
  policyRuleName: null,
  riskLevel: 'high',
  riskTags: ['MOVES_MONEY'],
  status: 'PENDING',
  requestedBy: 'ai-bot:chat',
  requestedByName: null,
  decidedByName: null,
  decisionChannel: null,
  decidedAt: null,
  decisionReason: null,
  expiresAt: '2026-10-04T10:40:00.000Z',
  createdAt: '2026-10-04T09:39:00.000Z',
  executionState: 'NOT_STARTED',
  executionError: null,
  executionAttempts: 0,
  customerNotifiedAt: null,
  ...over,
});
const matan: ApprovalCustomer = {
  name: 'Matan Amran',
  since: '2024-03-10T00:00:00.000Z',
  lifetime: null,
  refunds: 0,
  mood: null,
};

const show = (
  pending: readonly Approval[],
  extra: Partial<Parameters<typeof ApprovalsScreen>[0]> = {},
) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ approvals: messages }} timeZone="UTC">
      <ApprovalsScreen
        pending={pending}
        requesterNames={{}}
        serverNow={NOW}
        customers={{ a1: matan }}
        {...extra}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  approve.mockReset();
  reject.mockReset();
});

describe('★★ 03’s queue row', () => {
  it('the action and its amount; for whom and the order; the chip', () => {
    show([refund()]);
    const row = screen.getByTestId('queue-a1');
    expect(row).toHaveTextContent('Refund ₪179');
    expect(row).not.toHaveTextContent('for order');
    expect(screen.getByTestId('queue-meta-a1')).toHaveTextContent('Matan Amran · order #TEST-1842');
    expect(row).toHaveTextContent('Moves money');
  });

  it('the foot: what ran alone today, and where to change what needs asking', () => {
    show([refund()], { handledToday: 12 });
    expect(screen.getByTestId('queue-foot')).toHaveTextContent(
      'GOTCHA handled 12 on its own today.',
    );
    expect(screen.getByTestId('queue-foot').querySelector('a')).toHaveAttribute(
      'href',
      '/studio/capabilities',
    );
  });
});

describe('★★ 03’s detail', () => {
  it('eyebrow, title with the customer, the facts line - and no risk pills under it', () => {
    show([refund()], { aiAsked: ['a1'] });
    expect(screen.getByTestId('requested-by')).toHaveTextContent(
      /^Requested by your AI employee · \d{2}:\d{2}$/,
    );
    expect(screen.getByTestId('detail-title')).toHaveTextContent('Refund ₪179 to Matan Amran');
    expect(screen.getByTestId('detail-facts')).toHaveTextContent(
      'Order #TEST-1842 · damaged item · full refund recommended',
    );
    expect(screen.queryByTestId('risk-tags')).toBeNull();
    expect(screen.getByTestId('reversible')).toHaveTextContent('ReversibleNo');
  });

  it('a named requester is named', () => {
    show([refund()], { requesterNames: { a1: 'Support AI' } });
    expect(screen.getByTestId('requested-by')).toHaveTextContent(/^Requested by Support AI · /);
    expect(screen.getByTestId('ask-ai')).toHaveTextContent('Ask Support AI a question');
    expect(screen.getByTestId('ask-ai')).toHaveAttribute('aria-disabled', 'true');
  });

  it('why: one bullet a sentence', () => {
    show([refund()]);
    expect(
      [...screen.getByTestId('approval-reason').querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual([
      'Delivered 4 days ago, marked damaged on arrival.',
      'Customer sent a photo.',
      'Third contact about this order.',
    ]);
  });

  it('the customer: what is known, "-" for the rest', () => {
    show([refund()]);
    expect(screen.getByTestId('customer-since')).toHaveTextContent('March 2024');
    expect(screen.getByTestId('customer-refunds')).toHaveTextContent('None');
    expect(screen.getByTestId('customer-orders')).toHaveTextContent('-');
    expect(screen.getByTestId('customer-mood')).toHaveTextContent('-');
  });

  it('★ what approving does: no conversation, nobody is told; nothing claims "resolved"', () => {
    const one = show([refund()]);
    const chain = () => screen.getByTestId('approve-chain');
    expect(chain()).toHaveTextContent('₪179 refunded');
    expect(chain()).toHaveTextContent('Marked refunded in Shopify');
    expect(chain()).not.toHaveTextContent(/told|resolved/i);
    one.unmount();
    show([refund({ conversationId: 'c1' })]);
    expect(chain()).toHaveTextContent('Matan Amran told in the conversation');
  });
});

describe('★★ Edit amount - drawn until the platform can carry it, then a checked field', () => {
  it('not live: drawn, with why, and Approve sends the amount as asked', async () => {
    approve.mockResolvedValue({ ok: false, reason: 'stale' });
    show([refund()]);
    expect(screen.getByTestId('edit-amount')).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(screen.getByTestId('approve'));
    expect(approve).toHaveBeenCalledWith('a1');
  });

  it('live: nothing sent until Approve; a bad amount sends nothing; a good one is sent', async () => {
    approve.mockResolvedValue({ ok: false, reason: 'stale' });
    show([refund()], { editAmountLive: true });
    await userEvent.click(screen.getByTestId('edit-amount'));
    const field = screen.getByTestId('edit-amount-input');
    await userEvent.clear(field);
    await userEvent.type(field, '200');
    expect(screen.getByTestId('edit-problem')).toHaveTextContent('No more than ₪179.');
    await userEvent.click(screen.getByTestId('approve'));
    expect(approve).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, '120');
    expect(approve).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('approve'));
    expect(approve).toHaveBeenCalledWith('a1', { amount: 120 });
  });
});

describe('★ the rules behind the words', () => {
  it.each([
    ['shopify.process_refund', 'no'],
    ['shopify.cancel_order', 'no'],
    ['shopify.send_invoice', 'no'],
    ['shopify.add_order_note', 'yes'],
    ['shopify.update_order_shipping_address', 'yes'],
    ['propose_plan', null],
  ] as const)('%s reversible: %s', (tool, answer) => {
    expect(reversibilityOf(tool)).toBe(answer);
  });

  it.each([
    ['120', null],
    ['179', null],
    ['179.5', 'over'],
    ['0', 'invalid'],
    ['-5', 'invalid'],
    ['', 'invalid'],
    ['abc', 'invalid'],
  ] as const)('edited %j of 179 → %s', (raw, problem) => {
    expect(editedValueProblem(raw, 179)).toBe(problem);
  });

  it('bullets split on sentences and lines, never mid-number', () => {
    expect(whyBullets('Refund of 1.5 items. Second line\n- third')).toEqual([
      'Refund of 1.5 items.',
      'Second line',
      'third',
    ]);
  });
});

describe('★★ backend 05979604 - the allow-list, the units, the refusals', () => {
  it('a tool the platform will not edit: no Edit amount at all', () => {
    show(
      [
        refund({
          tool: 'shopify.cancel_order',
          facts: { order: '#1', amount: 50, currency: null, note: null, percentage: null },
        }),
      ],
      {
        editAmountLive: true,
      },
    );
    expect(screen.queryByTestId('edit-amount')).toBeNull();
  });

  it('a full refund carries no amount: drawn, with why', () => {
    show(
      [
        refund({
          facts: { order: '#1', amount: null, currency: null, note: null, percentage: null },
        }),
      ],
      {
        editAmountLive: true,
      },
    );
    expect(screen.getByTestId('edit-amount')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('edit-amount').getAttribute('title')).toMatch(
      /full refund with no amount/,
    );
  });

  it('a minor-unit tool takes whole numbers only', async () => {
    show(
      [
        refund({
          tool: 'stripe.refund_payment',
          facts: { order: null, amount: 500, currency: null, note: null, percentage: null },
        }),
      ],
      {
        editAmountLive: true,
      },
    );
    await userEvent.click(screen.getByTestId('edit-amount'));
    const field = screen.getByTestId('edit-amount-input');
    await userEvent.clear(field);
    await userEvent.type(field, '12.5');
    expect(screen.getByTestId('edit-problem')).toHaveTextContent('A whole number above zero.');
    await userEvent.click(screen.getByTestId('approve'));
    expect(approve).not.toHaveBeenCalled();
  });

  it.each([
    ['amount_above_original', 'An edited amount has to be less than what was asked.'],
    ['edit_not_allowed', "This action can't be approved with a different amount."],
  ])('a %s refusal is said in words - nothing decided', async (reason, words) => {
    approve.mockResolvedValue({ ok: false, reason });
    show([refund()], { editAmountLive: true });
    await userEvent.click(screen.getByTestId('edit-amount'));
    await userEvent.click(screen.getByTestId('approve'));
    expect(screen.getByTestId('approvals-announcement')).toHaveTextContent(words);
    expect(screen.getByTestId('approval-detail')).toBeInTheDocument();
  });

  it('the refund limit, when a policy sets one: the queue foot says it', () => {
    show([refund()], { refundLimit: 100, handledToday: 3 });
    expect(screen.getByTestId('queue-foot')).toHaveTextContent(
      'Refunds under 100 never reach you. GOTCHA handled 3 on its own today.',
    );
  });
});

describe('★★ backend f16a5afa - a discount is edited by its percentage', () => {
  const coupon = () =>
    refund({
      tool: 'shopify.create_discount_code',
      summary: 'Create discount code',
      facts: { order: null, amount: null, currency: null, note: null, percentage: 20 },
    });

  it('"Edit discount"; up to the original, never above 100; it sends { percentage }', async () => {
    approve.mockResolvedValue({ ok: false, reason: 'stale' });
    show([coupon()], { editAmountLive: true });
    expect(screen.getByTestId('edit-amount')).toHaveTextContent('Edit discount');
    await userEvent.click(screen.getByTestId('edit-amount'));
    const field = screen.getByTestId('edit-amount-input');
    await userEvent.clear(field);
    await userEvent.type(field, '25');
    expect(screen.getByTestId('edit-problem')).toHaveTextContent('No more than 20%.');
    await userEvent.click(screen.getByTestId('approve'));
    expect(approve).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, '12.5');
    await userEvent.click(screen.getByTestId('approve'));
    expect(approve).toHaveBeenCalledWith('a1', { percentage: 12.5 });
  });

  it('a coupon with no percentage: drawn, with why', () => {
    show(
      [
        refund({
          tool: 'shopify.create_vip_coupon',
          facts: { order: null, amount: null, currency: null, note: null, percentage: null },
        }),
      ],
      {
        editAmountLive: true,
      },
    );
    expect(screen.getByTestId('edit-amount')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('edit-amount').getAttribute('title')).toMatch(
      /no percentage to edit/,
    );
  });

  it.each([
    ['150', 100, 'invalid'],
    ['0', 20, 'invalid'],
    ['10.123', 20, 'invalid'],
    ['10.12', 20, null],
  ] as const)('percent %j of %i → %s', (raw, original, problem) => {
    expect(editedValueProblem(raw, original, 'percent')).toBe(problem);
  });
});

describe('★★ 03, this round', () => {
  it('E opens the edit field - and A’s key sits apart from the word', async () => {
    show([refund()], { editAmountLive: true });
    expect(screen.queryByTestId('edit-amount-input')).toBeNull();
    await userEvent.keyboard('e');
    expect(screen.getByTestId('edit-amount-input')).toHaveValue('179');
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByTestId('approve').querySelector('kbd')).toHaveTextContent('A');
  });

  it('E on a request nothing can edit does nothing - nor on a full refund with no amount', async () => {
    const one = show([refund({ tool: 'shopify.cancel_order' })], { editAmountLive: true });
    await userEvent.keyboard('e');
    expect(screen.queryByTestId('edit-amount-input')).toBeNull();
    one.unmount();
    show(
      [
        refund({
          facts: { order: '#1', amount: null, currency: null, note: null, percentage: null },
        }),
      ],
      { editAmountLive: true },
    );
    await userEvent.keyboard('e');
    expect(screen.queryByTestId('edit-amount-input')).toBeNull();
    // And no hidden edit is left behind to block approving it as it is.
    approve.mockResolvedValue({ ok: false, reason: 'stale' });
    await userEvent.click(screen.getByTestId('approve'));
    expect(approve).toHaveBeenCalledWith('a1');
  });

  it('"Decided earlier" carries every decision when none were today', () => {
    show([refund()], { decidedToday: 0, decidedTotal: 29 });
    expect(screen.getByTestId('decided-link')).toHaveTextContent('Decided earlier29');
  });

  it('a quiet day says so beside the link - the link never stands alone', () => {
    show([refund()], { handledToday: 0 });
    expect(screen.getByTestId('queue-foot')).toHaveTextContent(
      'GOTCHA handled nothing on its own today. Change what needs asking',
    );
  });
});
