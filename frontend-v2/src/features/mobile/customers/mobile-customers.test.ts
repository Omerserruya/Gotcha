import { describe, expect, it } from 'vitest';

import { orderStatus, ordersNote, phoneOf, worthOf } from './mobile-customers';

describe('the phone to dial: a whole international number, or none', () => {
  it('the first phone-keyed handle that is one; an Instagram id or a local number is not', () => {
    expect(
      phoneOf([
        { channel: 'INSTAGRAM', externalId: '1784000000000000' },
        { channel: 'WHATSAPP', externalId: '0521234567x' },
        { channel: 'WHATSAPP', externalId: '972521234567' },
      ]),
    ).toEqual({ channel: 'WHATSAPP', externalId: '972521234567', dial: '+972521234567' });
    expect(phoneOf([{ channel: 'EMAIL', externalId: 'a@b.co' }])).toBeNull();
  });
});

describe('★ the profile figures: what the store said, never a confident zero', () => {
  it('the store total first; per-currency totals otherwise; never summed across currencies', () => {
    expect(
      worthOf({
        orderCount: 6,
        shopCurrencyTotal: { amount: 2140, currency: 'ILS' },
        totalSpentByCurrency: [{ amount: 10, currency: 'USD' }],
        refundedOrCancelledCount: 1,
      }),
    ).toEqual({ spent: [{ amount: 2140, currency: 'ILS' }], orders: 6, refunds: 1 });
    expect(
      worthOf({
        orderCount: 2,
        totalSpentByCurrency: [
          { amount: 100, currency: 'ILS' },
          { amount: 20, currency: 'USD' },
          { amount: null, currency: 'EUR' },
        ],
      })?.spent,
    ).toEqual([
      { amount: 100, currency: 'ILS' },
      { amount: 20, currency: 'USD' },
    ]);
  });

  it('absent is absent: no spend, no refund count, no summary', () => {
    expect(worthOf({ orderCount: 0 })).toEqual({ spent: null, orders: 0, refunds: null });
    expect(worthOf(null)).toBeNull();
  });
});

describe('★ an order’s status: cancelled, else the furthest the store reports, in its words', () => {
  const order = {
    orderNumber: '1842',
    createdAt: '2026-11-01T10:00:00.000Z',
    total: { amount: 179, currency: 'ILS' },
    cancelled: false,
    financial: { label: 'Paid' },
    fulfillment: { label: 'Fulfilled' },
    shipping: { label: 'Delivered' },
  };

  it('shipping, then fulfilment, then payment', () => {
    expect(orderStatus(order)).toEqual({ kind: 'label', label: 'Delivered' });
    expect(orderStatus({ ...order, shipping: null })).toEqual({
      kind: 'label',
      label: 'Fulfilled',
    });
    expect(orderStatus({ ...order, shipping: null, fulfillment: null })).toEqual({
      kind: 'label',
      label: 'Paid',
    });
  });

  it('cancelled is said as that, over any chip; none at all is none', () => {
    expect(orderStatus({ ...order, cancelled: true })).toEqual({ kind: 'cancelled' });
    expect(
      orderStatus({ ...order, shipping: null, fulfillment: null, financial: null }),
    ).toBeNull();
  });
});

describe('★★ why there is no order: unknown is never "no orders"', () => {
  const read = (
    over: Partial<{
      source: string | null;
      state: string | null;
      reason: string | null;
      orders: unknown[];
    }>,
  ) => ({
    source: 'shopify',
    state: 'ok',
    reason: null,
    orders: [],
    ...over,
  });

  it('a failed read is unread; orders are no note', () => {
    expect(ordersNote(null)).toEqual({ kind: 'unread' });
    expect(ordersNote(read({ orders: [{}] }))).toBeNull();
  });

  it('no store read: the platform’s reason, or unread for one we have no words for', () => {
    expect(ordersNote(read({ source: null, reason: 'store_not_chosen' }))).toEqual({
      kind: 'storeNotChosen',
    });
    expect(ordersNote(read({ source: null, reason: 'no_store_connected' }))).toEqual({
      kind: 'notConnected',
    });
    expect(ordersNote(read({ source: null, reason: 'store_unreachable' }))).toEqual({
      kind: 'storeUnreachable',
    });
    expect(ordersNote(read({ source: null, reason: 'no_identifiers' }))).toEqual({
      kind: 'noIdentifiers',
    });
    expect(ordersNote(read({ source: null, reason: 'something_new' }))).toEqual({ kind: 'unread' });
  });

  it('Woo with nothing; Shopify’s own state, `ok` with none being "no orders yet"', () => {
    expect(ordersNote(read({ source: 'woocommerce', state: null }))).toEqual({
      kind: 'noWooOrders',
    });
    expect(ordersNote(read({}))).toEqual({ kind: 'state', state: 'no_orders' });
    expect(ordersNote(read({ state: 'customer_not_linked' }))).toEqual({
      kind: 'state',
      state: 'customer_not_linked',
    });
    expect(ordersNote(read({ state: 'missing_scopes' }))).toEqual({ kind: 'missingScopes' });
    expect(ordersNote(read({ state: null }))).toEqual({ kind: 'unread' });
  });
});
