import { describe, expect, it } from 'vitest';

import { CHECKOUT_STATUSES, type CheckoutStatus } from '@/api/contracts/checkout';

import { CHECKOUT_PAGES, pageForStatus, pageShows, referenceFrom } from './checkout-pages';

/**
 * Which page a status belongs on - billing's `SafeStatus`, every member of it
 * (enumerated from the contract, so a status added there is a status asked
 * about here).
 */
const EXPECTED: Record<CheckoutStatus, string> = {
  AWAITING_PAYMENT_SETUP: 'payment-required',
  PAYMENT_REQUIRED: 'payment-required',
  PROCESSING: 'processing',
  MANUAL_REVIEW: 'processing',
  FAILED: 'failed',
  EXPIRED: 'expired',
  COMPLETED: 'completed',
};

describe('★★ the server says where a checkout belongs', () => {
  it.each(CHECKOUT_STATUSES)('%s', (status) => {
    expect(pageForStatus(status)).toBe(EXPECTED[status]);
    expect(pageShows(pageForStatus(status), status)).toBe(true);
  });

  it('every status has exactly one page, and no page but its own shows it (cancelled aside)', () => {
    for (const status of CHECKOUT_STATUSES) {
      const showing = CHECKOUT_PAGES.filter(
        (page) => page !== 'cancelled' && pageShows(page, status),
      );
      expect(showing).toEqual([EXPECTED[status]]);
    }
  });

  it('★ cancelled shows only a checkout still asking for payment - a paid one is moved on', () => {
    expect(pageShows('cancelled', 'PAYMENT_REQUIRED')).toBe(true);
    expect(pageShows('cancelled', 'AWAITING_PAYMENT_SETUP')).toBe(true);
    expect(pageShows('cancelled', 'COMPLETED')).toBe(false);
    expect(pageShows('cancelled', 'PROCESSING')).toBe(false);
  });
});

describe('the reference from a query', () => {
  it.each([
    ['chk_abc', 'chk_abc'],
    ['abc', null],
    ['', null],
    [undefined, null],
    [['chk_a', 'chk_b'], null],
  ])('%j → %j', (value, expected) => {
    expect(referenceFrom(value as string | string[] | undefined)).toBe(expected);
  });
});
