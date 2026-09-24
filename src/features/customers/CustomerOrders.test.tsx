import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  commerceContextSchema,
  COMMERCE_STATES,
  type CommerceContextResponse,
} from '@/api/contracts/customer-orders';
import messages from '@/i18n/messages/en/customers.json';

import { CustomerOrders } from './CustomerOrders';

/**
 * Screen 04d.
 *
 * Almost none of this is reachable by a capture on this tenant: Shopify is in
 * ERROR, so the live response is `connection_unhealthy` and the seven other
 * states — including every order card — are unit-only.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const show = async (orders: CommerceContextResponse | null) =>
  render(await CustomerOrders({ orders }));

const order = (over: Record<string, unknown> = {}) => ({
  orderId: 'o1',
  orderNumber: '#1246',
  createdAt: '2026-09-16T11:02:00.000Z',
  total: { amount: 420, currency: 'ILS' },
  financial: { key: 'paid', label: 'Paid', tone: 'positive' },
  fulfillment: { key: 'fulfilled', label: 'Fulfilled', tone: 'positive' },
  cancelled: false,
  refund: null,
  shipping: null,
  items: [{ title: 'Olive oil', quantity: 6 }],
  extraItemCount: 0,
  refundedAmount: { amount: null, currency: null },
  refundableMaximum: { amount: null, currency: null },
  eligibility: {
    cancellable: false,
    refundable: false,
    returnable: false,
    exchangeable: false,
    reasonIfNot: null,
  },
  ...over,
});

const ok = (orders: Record<string, unknown>[]) =>
  commerceContextSchema.parse({ state: 'ok', data: { recentOrders: orders } });

describe('★★ eight states, rendered as eight', () => {
  it('gives every non-ok state its own sentence', async () => {
    /*
     * `CommerceContextResponse`'s own comment asks for this: the frontend
     * "renders an explicit UI for each state — it never guesses from a bare
     * error". Collapsing them destroys five different repairs.
     *
     * Asserted over ALL of them from the constant, so a state added to the
     * union without a sentence fails here rather than rendering blank.
     */
    for (const state of COMMERCE_STATES) {
      if (state === 'ok') continue;
      const { unmount } = await show(
        commerceContextSchema.parse({ state, missing: ['read_orders'] }),
      );
      const block = screen.getByTestId(`orders-${state}`);
      expect(block, `${state} rendered nothing`).toHaveTextContent(/\S/);
      unmount();
    }
  });

  it('★ never connected and connected-but-broken are different instructions', async () => {
    /*
     * The distinction this project has made on 13, 14 and 17, made here by
     * Backend before we arrived. "Connect a store" is the wrong sentence for
     * somebody who already connected one and is watching it fail.
     */
    const { unmount } = await show(commerceContextSchema.parse({ state: 'not_connected' }));
    expect(screen.getByTestId('orders-not_connected')).toHaveTextContent(/No store is connected/i);
    unmount();

    await show(commerceContextSchema.parse({ state: 'connection_unhealthy' }));
    const broken = screen.getByTestId('orders-connection_unhealthy');
    expect(broken).toHaveTextContent(/connected and not working/i);
    // And never the instruction meant for the other state.
    expect(broken).not.toHaveTextContent(/Connect one in Business core/i);
  });

  it('★ names the missing scopes, and says the repair is in Shopify', async () => {
    // "Permissions are missing" sends somebody hunting for a setting. The
    // list tells them which to grant, and where.
    await show(
      commerceContextSchema.parse({
        state: 'missing_scopes',
        missing: ['read_orders', 'read_fulfillments'],
      }),
    );
    const block = screen.getByTestId('orders-missing_scopes');
    expect(block).toHaveTextContent(/read_orders/);
    expect(block).toHaveTextContent(/read_fulfillments/);
    expect(block).toHaveTextContent(/in Shopify/i);
  });

  it('distinguishes a failed READ from any of the eight answers', async () => {
    // `null` is our fetch failing. All eight states are successful answers
    // about why there are no orders, and must not share a sentence with it.
    await show(null);
    expect(screen.getByTestId('orders-unread')).toHaveTextContent(/couldn't read/i);
  });
});

describe('★ the order cards', () => {
  it('renders the platform’s chips verbatim, with its tone', async () => {
    /*
     * Labels arrive already localised and the tone is the platform's
     * judgement. Re-deriving either would make this screen disagree with the
     * Inbox about the same order.
     */
    await show(
      ok([
        order({ fulfillment: { key: 'partial', label: 'Partially fulfilled', tone: 'warning' } }),
      ]),
    );
    const chip = screen.getByTestId('chip-o1-partial');
    expect(chip).toHaveTextContent('Partially fulfilled');
    expect(chip).toHaveAttribute('data-tone', 'warning');
  });

  it('★★ expands the TROUBLED order, not simply the first', async () => {
    /*
     * The design opens "the open or troubled order". Troubled is derived
     * from the platform's own tones, so if they decide a state is alarming
     * this screen agrees with them.
     */
    const calm = order({ orderId: 'calm' });
    const troubled = order({
      orderId: 'troubled',
      fulfillment: { key: 'partial', label: 'Partially fulfilled', tone: 'warning' },
    });
    await show(ok([calm, troubled]));
    expect(screen.getByTestId('order-troubled')).toHaveAttribute('data-expanded', 'yes');
    expect(screen.getByTestId('order-calm')).toHaveAttribute('data-expanded', 'no');
    // Exactly one: a screen that expands three has expanded none.
    expect(screen.getByTestId('order-detail-troubled')).toBeInTheDocument();
    expect(screen.queryByTestId('order-detail-calm')).toBeNull();
  });

  it('★ says how many items it is NOT showing', async () => {
    // A card listing three of eleven that says nothing looks like an order
    // with three items.
    await show(ok([order({ extraItemCount: 3 })]));
    expect(screen.getByTestId('order-more-o1')).toHaveTextContent(/3 more items/i);
  });

  it('shows the refundable ceiling, not just that a refund is possible', async () => {
    // "Refundable" and "refundable for how much" are different facts, and the
    // second is what decides whether somebody opens the conversation.
    await show(
      ok([
        order({
          refundableMaximum: { amount: 420, currency: 'ILS' },
          eligibility: {
            cancellable: false,
            refundable: true,
            returnable: false,
            exchangeable: false,
            reasonIfNot: null,
          },
        }),
      ]),
    );
    expect(screen.getByTestId('order-ceiling-o1')).toHaveTextContent(/420/);
  });

  it('renders the platform’s own reason when nothing is possible', async () => {
    await show(
      ok([
        order({
          eligibility: {
            cancellable: false,
            refundable: false,
            returnable: false,
            exchangeable: false,
            reasonIfNot: 'Delivered more than 30 days ago.',
          },
        }),
      ]),
    );
    expect(screen.getByTestId('order-why-not-o1')).toHaveTextContent(/30 days ago/);
  });
});

describe('★★ what could be done is SAID, and never offered', () => {
  it('lists the possible actions without drawing a single control', async () => {
    /*
     * `POST /api/commerce-context/:conversationId/actions` is the best-guarded
     * write in the platform — and it is conversation-keyed.
     * `commerce-actions.service.ts:190` writes the audit with
     * `metadata: { conversationId }`, so an action taken here would be
     * recorded against whichever conversation this page entered through.
     *
     * A wrong audit trail, on the actions whose whole purpose is leaving a
     * right one.
     */
    const { container } = await show(
      ok([
        order({
          eligibility: {
            cancellable: false,
            refundable: true,
            returnable: true,
            exchangeable: false,
            reasonIfNot: null,
          },
        }),
      ]),
    );
    const possible = screen.getByTestId('order-possible-o1');
    expect(possible).toHaveTextContent(/refund it/i);
    expect(possible).toHaveTextContent(/open a return/i);

    // Nothing to press, anywhere.
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });

  it('★ explains WHY there is nothing to press', async () => {
    // A merchant who reads "a refund is possible" and finds no button is owed
    // the reason, and the reason is ours rather than the platform's.
    await show(ok([order()]));
    const note = screen.getByTestId('orders-no-actions');
    expect(note).toHaveTextContent(/done in the conversation/i);
    expect(note).toHaveTextContent(/wrong conversation/i);
  });
});
