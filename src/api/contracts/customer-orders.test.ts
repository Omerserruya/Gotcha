import { describe, expect, it } from 'vitest';

import { commerceContextSchema, moneySchema, shopifyAdminHref } from './customer-orders';

/**
 * The commerce contract against the wire's own shape
 * (`packages/shared/src/lib/commerce-context.types.ts`).
 */

const order = (over: Record<string, unknown> = {}) => ({
  orderId: 'o1',
  orderNumber: '#1842',
  adminUrl: 'https://store.myshopify.com/admin/orders/o1',
  createdAt: '2026-08-19T10:00:00.000Z',
  total: { amount: '358.00', currency: 'ILS' },
  financial: { key: 'paid', label: 'Paid', tone: 'positive' },
  fulfillment: { key: 'fulfilled', label: 'Fulfilled', tone: 'positive' },
  cancelled: false,
  refund: null,
  shipping: { key: 'shipped', label: 'Shipped', tone: 'neutral' },
  items: [{ title: 'Linen pillowcases', quantity: 1, imageUrl: null }],
  extraItemCount: 0,
  refundedAmount: { amount: '0.00', currency: 'ILS' },
  refundableMaximum: { amount: '358.00', currency: 'ILS' },
  timeline: [
    { key: 'placed', label: 'Order placed', at: '2026-08-19T10:00:00.000Z', reached: true },
  ],
  eligibility: { cancellable: false, refundable: true, returnable: true, exchangeable: false },
  ...over,
});

describe('★★ money is a decimal string on the wire', () => {
  it('★★ an `ok` response with string amounts parses — the number-typed contract threw here', () => {
    const parsed = commerceContextSchema.parse({
      state: 'ok',
      data: {
        summary: { orderCount: 1, totalSpentByCurrency: [{ amount: '358.00', currency: 'ILS' }] },
        recentOrders: [order()],
        fetchedAt: '2026-09-18T09:20:00.000Z',
      },
    });
    const first = parsed.data!.recentOrders[0]!;
    expect(first.total).toEqual({ amount: 358, currency: 'ILS' });
    expect(first.refundableMaximum.amount).toBe(358);
  });

  it('⚠ empty, absent and unparseable are null — never a confident 0', () => {
    expect(moneySchema.parse({ amount: '', currency: 'ILS' }).amount).toBeNull();
    expect(moneySchema.parse({ currency: 'ILS' }).amount).toBeNull();
    expect(moneySchema.parse({ amount: 'n/a', currency: 'ILS' }).amount).toBeNull();
    expect(moneySchema.parse({ amount: 12.5, currency: 'ILS' }).amount).toBe(12.5);
    expect(moneySchema.parse({ amount: '0.00', currency: 'ILS' }).amount).toBe(0);
  });
});

describe('★★ the fields 04d draws arrive — they were on the wire and stripped', () => {
  it('the admin link, the milestones, the detail, and the summary’s figures', () => {
    const parsed = commerceContextSchema.parse({
      state: 'ok',
      data: {
        summary: {
          orderCount: 6,
          averageOrderValue: { amount: '357.00', currency: 'ILS' },
          customerSince: '2024-03-01T00:00:00.000Z',
          defaultAddress: 'Ben Yehuda 18, Tel Aviv',
          openOrderCount: 1,
          refundedOrCancelledCount: 0,
        },
        recentOrders: [
          order({
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
          }),
        ],
      },
    });
    const summary = parsed.data!.summary!;
    expect(summary.averageOrderValue?.amount).toBe(357);
    expect(summary.defaultAddress).toBe('Ben Yehuda 18, Tel Aviv');
    expect(summary.openOrderCount).toBe(1);
    const first = parsed.data!.recentOrders[0]!;
    expect(first.adminUrl).toBe('https://store.myshopify.com/admin/orders/o1');
    expect(first.timeline.map((m) => m.key)).toEqual(['placed']);
    expect(first.detail?.lineItems[0]?.unitPrice?.amount).toBe(179);
    expect(first.detail?.tracking[0]).toEqual({
      number: 'RR204917IL',
      company: 'Israel Post',
      url: null,
    });
  });

  it('an order with no detail is still an order', () => {
    const parsed = commerceContextSchema.parse({
      state: 'ok',
      data: { recentOrders: [order({ detail: undefined, timeline: undefined })] },
    });
    expect(parsed.data!.recentOrders[0]!.detail).toBeNull();
    expect(parsed.data!.recentOrders[0]!.timeline).toEqual([]);
  });
});

describe('★★ shopifyAdminHref — a Shopify admin link, or nothing', () => {
  it('passes the shape the service builds', () => {
    expect(shopifyAdminHref('https://store.myshopify.com/admin/orders/1')).toBe(
      'https://store.myshopify.com/admin/orders/1',
    );
    expect(shopifyAdminHref('https://admin.shopify.com/store/x/orders/1')).toBe(
      'https://admin.shopify.com/store/x/orders/1',
    );
  });

  it.each([
    ['http, not https', 'http://store.myshopify.com/admin/orders/1'],
    ['another host', 'https://evil.example/admin/orders/1'],
    ['a lookalike suffix', 'https://store.myshopify.com.evil.example/admin'],
    ['credentials before the host', 'https://store.myshopify.com@evil.example/admin'],
    ['credentials on a real host', 'https://user:pw@store.myshopify.com/admin/orders/1'],
    ['a script', 'javascript:alert(1)'],
    ['tab inside the scheme', 'https:\t//evil.example/.myshopify.com'],
    ['not a URL', 'store.myshopify.com/admin'],
    ['empty', ''],
  ])('⚠ refuses %s', (_label, href) => {
    expect(shopifyAdminHref(href)).toBeNull();
  });

  it('null and undefined are null', () => {
    expect(shopifyAdminHref(null)).toBeNull();
    expect(shopifyAdminHref(undefined)).toBeNull();
  });
});
