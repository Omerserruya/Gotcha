import { describe, expect, it } from 'vitest';

import { phoneOf, worthOf } from './mobile-customers';

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
