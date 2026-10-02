import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  commerceContextSchema,
  COMMERCE_STATES,
  type CommerceContextResponse,
} from '@/api/contracts/customer-orders';
import messages from '@/i18n/messages/en/customers.json';

import {
  OrdersTab,
  isOpenOrder,
  isReturnOrder,
  OrdersSide,
  parseOrderFilter,
  statusChipOf,
  type OrderFilter,
} from './OrdersTab';

/**
 * Screen 04d.
 *
 * Almost none of this is reachable by a capture on this tenant: Shopify is in
 * ERROR, so the live response is `connection_unhealthy` and the seven other
 * states — including every order card — are unit-only.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: React.ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers') =>
    createTranslator({ locale: 'en', messages: { customers: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

/*
 * `conversationId` defaults to null here, so the order-card tests assert the
 * SAID-not-offered branch. The action controls have their own file — they
 * are a client component and belong with the outcomes they render.
 */
const show = async (orders: CommerceContextResponse | null, conversationId: string | null = null) =>
  render(
    /*
     * Wrapped, because `OrderActions` is a CLIENT component inside this
     * server tree and `useTranslations` needs a context the server mock does
     * not supply. Fourth time this session — the tell is always the same
     * sentence about `NextIntlClientProvider`, and it names the component
     * rather than the harness.
     */
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      {await OrdersTab({ orders, conversationId })}
    </NextIntlClientProvider>,
  );

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
describe('★ with no conversation to act through, what could be done is still SAID', () => {
  it('names the possible actions and draws no control', async () => {
    /*
     * The actions post to `/commerce-context/:conversationId/actions`. A
     * person with no conversation has nowhere for one to route, so the
     * controls are absent rather than broken — and what could be done is
     * still said, because it is a fact about the order.
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
      null,
    );
    expect(screen.getByTestId('order-possible-o1')).toHaveTextContent(/Refund/i);
    expect(container.querySelector('button')).toBeNull();
    expect(screen.getByTestId('orders-no-conversation')).toHaveTextContent(
      /no conversation with this person/i,
    );
  });

  it('★ offers the controls once there IS a conversation', async () => {
    /*
     * The ruling sharpened rather than reversed: both this write and
     * `createNote` are conversation-keyed, but `writeAudit` targets
     * `customer`/`order` and carries the conversation as metadata CONTEXT,
     * while `createNote` uses it as the record's identity in the merchant's
     * own CRM.
     *
     * A conversation key is a problem when it is the record's identity and
     * acceptable when it is context on a record already keyed to the person.
     */
    await show(
      ok([
        order({
          eligibility: {
            cancellable: false,
            refundable: true,
            returnable: false,
            exchangeable: false,
            reasonIfNot: null,
          },
        }),
      ]),
      'conv-1',
    );
    expect(screen.getByTestId('order-action-o1-refund')).toBeInTheDocument();
    // And the said-instead sentence is gone, because it is no longer true.
    expect(screen.queryByTestId('orders-no-conversation')).toBeNull();
  });
});

const showFiltered = async (orders: CommerceContextResponse, filter: OrderFilter) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers: messages }}>
      {await OrdersTab({ orders, conversationId: null, filter })}
    </NextIntlClientProvider>,
  );

/** The wire's shape: string amounts, `buildTimeline`'s milestones, the detail. */
const wire = (over: Record<string, unknown> = {}) =>
  order({
    adminUrl: 'https://store.myshopify.com/admin/orders/o1',
    total: { amount: '358.00', currency: 'ILS' },
    shipping: { key: 'shipped', label: 'Shipped', tone: 'neutral' },
    timeline: [
      { key: 'placed', label: 'Order placed', at: '2026-08-19T10:00:00.000Z', reached: true },
      { key: 'payment', label: 'Payment confirmed', at: '2026-08-19T10:01:00.000Z', reached: true },
      { key: 'fulfilled', label: 'Fulfilled', at: '2026-08-20T10:00:00.000Z', reached: true },
      { key: 'shipped', label: 'Shipped', at: null, reached: true },
      { key: 'delivered', label: 'Delivered', at: null, reached: false },
    ],
    detail: {
      lineItems: [
        {
          lineItemId: 'li1',
          title: 'Linen pillowcases',
          variantTitle: 'Sand · pair',
          quantity: 1,
          unitPrice: { amount: '179.00', currency: 'ILS' },
          lineTotal: { amount: '179.00', currency: 'ILS' },
          imageUrl: null,
        },
      ],
      itemCount: 1,
      tracking: [{ number: 'RR204917IL', company: 'Israel Post' }],
      shippingAddress: 'Ben Yehuda 18, Tel Aviv',
      tags: [],
      refunds: [],
    },
    ...over,
  });

describe('★★ 04d — the open order, drawn whole', () => {
  it('★ the lead: count, spend and open, from the summary; and when it was read', async () => {
    await show(
      commerceContextSchema.parse({
        state: 'ok',
        data: {
          summary: {
            orderCount: 6,
            shopCurrencyTotal: { amount: '2140.00', currency: 'ILS' },
            openOrderCount: 1,
          },
          recentOrders: [wire()],
          fetchedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        },
      }),
    );
    const lead = screen.getByTestId('orders-lead');
    expect(lead).toHaveTextContent('6 orders');
    expect(lead).toHaveTextContent('2,140');
    expect(lead).toHaveTextContent('1 open');
    expect(lead).toHaveTextContent(/From Shopify · synced 2 minutes ago/);
  });

  it('★★ one status chip — what happened last — and payment only when it is news', async () => {
    await show(
      ok([
        wire({ orderId: 'a' }),
        wire({
          orderId: 'b',
          financial: { key: 'pending', label: 'Payment pending', tone: 'warning' },
        }),
      ]),
    );
    expect(screen.getByTestId('chip-a-shipped')).toHaveTextContent('Shipped');
    expect(screen.queryByTestId('chip-a-paid')).toBeNull();
    expect(screen.queryByTestId('chip-a-fulfilled')).toBeNull();
    expect(screen.getByTestId('chip-b-pending')).toHaveAttribute('data-tone', 'warning');
  });

  it('★★ the tracker is Shopify’s milestones: reached, and ahead', async () => {
    await show(ok([wire()]));
    const steps = [...screen.getByTestId('order-tracker-o1').querySelectorAll('li')];
    expect(steps.map((li) => li.getAttribute('data-state'))).toEqual([
      'reached',
      'reached',
      'reached',
      'reached',
      'ahead',
    ]);
    expect(steps[0]).toHaveTextContent('Order placed');
    // Reached with no time from Shopify: the step stays, its date is "—".
    expect(steps[3]).toHaveTextContent('—');
  });

  it('★ line items from the detail, with their prices; the facts with "—" where none', async () => {
    await show(ok([wire()]));
    const card = screen.getByTestId('order-o1');
    expect(card).toHaveTextContent('Linen pillowcases · Sand · pair');
    expect(card).toHaveTextContent('Qty 1');
    expect(card).toHaveTextContent('179');
    expect(card).toHaveTextContent('RR204917IL · Israel Post');
    expect(card).toHaveTextContent('Ben Yehuda 18, Tel Aviv');
    expect(card).toHaveTextContent(/Carrier case\s*—/);
  });

  it('⚠ without the detail the items still show, priced "—"', async () => {
    await show(ok([order()]));
    expect(screen.getByTestId('order-o1')).toHaveTextContent('Olive oil');
    expect(screen.getByTestId('order-o1')).toHaveTextContent('—');
  });

  it('★★ "Open in Shopify" is the guarded admin link — or drawn without one', async () => {
    await show(
      ok([
        wire({ orderId: 'good' }),
        wire({ orderId: 'bad', adminUrl: 'https://evil.example/admin/orders/1' }),
      ]),
    );
    // Only the expanded order carries the foot.
    expect(screen.getByTestId('order-admin-good')).toHaveAttribute(
      'href',
      'https://store.myshopify.com/admin/orders/o1',
    );
    expect(screen.getByTestId('order-admin-good')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('⚠ a bad admin URL draws the words with no link', async () => {
    await show(ok([wire({ adminUrl: 'javascript:alert(1)' })]));
    expect(screen.queryByTestId('order-admin-o1')).toBeNull();
    expect(screen.getByText('Open in Shopify')).toHaveAttribute('aria-disabled', 'true');
  });

  it('★ the other orders are one line each, with no detail', async () => {
    await show(ok([wire({ orderId: 'first' }), wire({ orderId: 'second' })]));
    expect(screen.getByTestId('order-second')).toHaveAttribute('data-expanded', 'no');
    expect(screen.queryByTestId('order-detail-second')).toBeNull();
    expect(screen.getByTestId('order-second')).toHaveTextContent('358');
  });
});

describe('★ 04d’s filters: All, Open, Returns — by the platform’s keys', () => {
  const delivered = wire({
    orderId: 'done',
    shipping: { key: 'delivered', label: 'Delivered', tone: 'positive' },
  });
  const inTransit = wire({ orderId: 'moving' });
  const refunded = wire({
    orderId: 'back',
    shipping: { key: 'delivered', label: 'Delivered', tone: 'positive' },
    refund: { key: 'refunded', label: 'Refunded', tone: 'danger' },
  });

  it('Open keeps what has not reached them', async () => {
    await showFiltered(ok([delivered, inTransit, refunded]), 'open');
    expect(screen.getByTestId('order-moving')).toBeInTheDocument();
    expect(screen.queryByTestId('order-done')).toBeNull();
    expect(screen.queryByTestId('order-back')).toBeNull();
  });

  it('Returns keeps what was refunded or cancelled', async () => {
    await showFiltered(ok([delivered, inTransit, refunded]), 'returns');
    expect(screen.getByTestId('order-back')).toBeInTheDocument();
    expect(screen.queryByTestId('order-moving')).toBeNull();
  });

  it('⚠ a filter that keeps nothing says so in one line', async () => {
    await showFiltered(ok([delivered]), 'returns');
    expect(screen.getByTestId('orders-filter-empty')).toHaveTextContent('No orders here.');
  });

  it('the rules, directly', () => {
    const parse = (o: Record<string, unknown>) => ok([o]).data!.recentOrders[0]!;
    expect(isOpenOrder(parse(inTransit))).toBe(true);
    expect(isOpenOrder(parse(delivered))).toBe(false);
    expect(isOpenOrder(parse(wire({ cancelled: true })))).toBe(false);
    expect(isReturnOrder(parse(refunded))).toBe(true);
    expect(isReturnOrder(parse(wire({ cancelled: true })))).toBe(true);
    expect(isReturnOrder(parse(inTransit))).toBe(false);
    expect(statusChipOf(parse(refunded))?.key).toBe('refunded');
    expect(statusChipOf(parse(order()))?.key).toBe('fulfilled');
    expect(parseOrderFilter('open')).toBe('open');
    expect(parseOrderFilter('nope')).toBe('all');
    expect(parseOrderFilter(undefined)).toBe('all');
  });
});

describe('★★ 04d’s side — the summary’s own figures, and "—" for what nothing records', () => {
  it('average, open, the address on file, refunded-or-cancelled', async () => {
    render(
      await OrdersSide({
        orders: commerceContextSchema.parse({
          state: 'ok',
          data: {
            summary: {
              orderCount: 6,
              averageOrderValue: { amount: '357.00', currency: 'ILS' },
              defaultAddress: 'Ben Yehuda 18, Tel Aviv',
              openOrderCount: 1,
              refundedOrCancelledCount: 2,
            },
          },
        }),
      }),
    );
    const across = screen.getByTestId('orders-across');
    expect(across).toHaveTextContent('357');
    expect(across).toHaveTextContent('open now1');
    expect(across).toHaveTextContent('arrived on time—');
    const onFile = screen.getByTestId('orders-on-file');
    expect(onFile).toHaveTextContent('Ben Yehuda 18, Tel Aviv');
    expect(onFile).toHaveTextContent('Payment—');
    expect(onFile).toHaveTextContent('2 refunded or cancelled');
    expect(screen.getByTestId('orders-buys')).toHaveTextContent('Nothing yet.');
    expect(screen.getByTestId('promise-card')).toBeInTheDocument();
  });

  it('⚠ no read, no summary: every block stays, every figure "—"', async () => {
    render(await OrdersSide({ orders: null }));
    const across = screen.getByTestId('orders-across');
    expect(across.textContent?.match(/—/g)).toHaveLength(3);
    expect(screen.getByTestId('orders-on-file').textContent?.match(/—/g)).toHaveLength(3);
  });
});
