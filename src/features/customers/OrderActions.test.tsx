import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { orderCardSchema } from '@/api/contracts/customer-orders';
import messages from '@/i18n/messages/en/customers.json';

import { OrderActions } from './OrderActions';

/**
 * Screen 04d's controls. Every branch here is about money.
 *
 * ── NOTHING IN THIS FILE CALLS THE REAL ACTION ──
 * `runOrderAction` is mocked. The real one cancels, refunds and returns
 * orders in a live Shopify store through the platform's hardened path; a test
 * that called it would move a merchant's money.
 */

const runOrderAction = vi.hoisted(() => vi.fn());
vi.mock('./order-actions', () => ({ runOrderAction }));

beforeEach(() => {
  runOrderAction.mockReset();
  runOrderAction.mockResolvedValue({ state: 'pending_approval', approvalRequestId: 'a1' });
});

const order = (over: Record<string, unknown> = {}) =>
  orderCardSchema.parse({
    orderId: 'o1',
    orderNumber: '#1246',
    total: { amount: 420, currency: 'ILS' },
    financial: { key: 'paid', label: 'Paid', tone: 'positive' },
    eligibility: { cancellable: false, refundable: true, returnable: false, exchangeable: false },
    ...over,
  });

const show = (over: Record<string, unknown> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      <OrderActions order={order(over)} conversationId="conv-1" />
    </NextIntlClientProvider>,
  );

describe('★★ only one of five outcomes means it happened', () => {
  it('★★ pending_approval is neither done nor failed', async () => {
    /*
     * THE OUTCOME A SCREEN GETS WRONG. The action is in the queue screen 03
     * renders, holding until a person decides. Shown as done, somebody stops
     * watching for it; shown as failed, somebody does it again — and on a
     * refund that is the same money twice.
     */
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('order-action-o1-refund'));

    const pending = await screen.findByTestId('order-pending-o1');
    expect(pending).toHaveTextContent(/waiting for someone to approve/i);
    expect(pending).toHaveTextContent(/hasn't happened yet, and it hasn't failed/i);
    // Never a verified card: nothing was verified.
    expect(screen.queryByTestId('order-verified-o1')).toBeNull();
  });

  it('★★ renders the chips from the VERIFIED card, never from the button pressed', async () => {
    /*
     * `commerce-actions.service.ts` runs a post-action verify and returns
     * the provider's own card: *"a button click never mutates order state in
     * the UI; the caller updates only from the verified result returned
     * here."*
     *
     * So pressing Refund does not make a card say "Refunded". The PROVIDER
     * saying so makes it say so — and this fixture has the provider
     * reporting only a partial refund, which an optimistic screen would have
     * drawn as complete.
     */
    runOrderAction.mockResolvedValue({
      state: 'executed',
      order: order({
        orderId: 'o1',
        refund: { key: 'partially_refunded', label: 'Partially refunded', tone: 'warning' },
      }),
    });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('order-action-o1-refund'));

    const chip = await screen.findByTestId('verified-chip-o1-partially_refunded');
    expect(chip).toHaveTextContent('Partially refunded');
    expect(chip).toHaveAttribute('data-tone', 'warning');
  });

  it('a denial says nothing was changed', async () => {
    runOrderAction.mockResolvedValue({ state: 'denied', reason: 'policy_denied' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('order-action-o1-refund'));
    expect(await screen.findByTestId('order-denied-o1')).toHaveTextContent(/Nothing was changed/i);
  });

  it('★★ a thrown request is UNKNOWN, not failed, and invites no retry', async () => {
    /*
     * The 17d distinction, on an endpoint that moves a merchant's money
     * rather than takes it. "It failed, try again" on an outcome nobody has
     * settled is how a refund gets issued twice — and a second refund is not
     * recoverable by pressing something else.
     */
    runOrderAction.mockResolvedValue(null);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('order-action-o1-refund'));

    const unknown = await screen.findByTestId('order-unknown-o1');
    expect(unknown).toHaveTextContent(/don't know whether that went through/i);
    expect(unknown).toHaveTextContent(/do NOT try it again/i);
    // The words that would undo it.
    expect(unknown).not.toHaveTextContent(/failed/i);
  });
});

describe('★ one press per order', () => {
  it('disables every control once anything has been attempted', async () => {
    /*
     * The outcome may be `pending_approval`. A second press on an action
     * already waiting for a human is a second request for the same money,
     * and the idempotency key will not save it — that guards a double-click
     * on ONE request, not two deliberate ones.
     */
    const user = userEvent.setup();
    show({
      eligibility: { cancellable: true, refundable: true, returnable: false, exchangeable: false },
    });
    await user.click(screen.getByTestId('order-action-o1-refund'));

    expect(await screen.findByTestId('order-pending-o1')).toBeInTheDocument();
    expect(screen.getByTestId('order-action-o1-refund')).toBeDisabled();
    // Including the OTHER action: cancelling an order whose refund is
    // awaiting approval is a decision nobody has made yet.
    expect(screen.getByTestId('order-action-o1-cancel')).toBeDisabled();
  });

  it('sends the same idempotency key for the same order', async () => {
    // The service turns a double-click into one operation by this key.
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('order-action-o1-refund'));
    expect(runOrderAction).toHaveBeenCalledWith(
      'conv-1',
      'o1',
      'refund',
      expect.stringContaining('order:o1:'),
    );
  });

  it('draws nothing when nothing is eligible, and says why', async () => {
    show({
      eligibility: {
        cancellable: false,
        refundable: false,
        returnable: false,
        exchangeable: false,
        reasonIfNot: 'Delivered more than 30 days ago.',
      },
    });
    expect(screen.getByTestId('order-why-not-o1')).toHaveTextContent(/30 days ago/);
    expect(screen.queryByTestId('order-actions-o1')).toBeNull();
  });
});
