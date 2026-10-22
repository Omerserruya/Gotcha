import type { CheckoutStatus } from '@/api/contracts/checkout';

/**
 * The checkout's pages, and which status belongs on which.
 *
 * The SERVER says where a checkout stands; every page reads it and moves the
 * visitor when it is not theirs. These URLs are emailed, bookmarked and
 * returned to from the provider hours later, so a stale one corrects itself
 * instead of telling the wrong story - a paid checkout never asks for a card.
 *
 * One table, read by every page (and by the link that opens one), so no page
 * keeps its own idea of where a status belongs.
 */
export const CHECKOUT_PAGES = [
  'payment-required',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;
export type CheckoutPage = (typeof CHECKOUT_PAGES)[number];

/** The page a status belongs on (legacy `pathForStatus`). */
export function pageForStatus(status: CheckoutStatus): Exclude<CheckoutPage, 'cancelled'> {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'EXPIRED':
      return 'expired';
    case 'FAILED':
      return 'failed';
    case 'PROCESSING':
    case 'MANUAL_REVIEW':
      return 'processing';
    case 'PAYMENT_REQUIRED':
    case 'AWAITING_PAYMENT_SETUP':
      return 'payment-required';
  }
}

/**
 * The statuses a page shows; any other is moved on. Cancelled is the
 * payment-required checkout seen from the provider's Cancel - it changes
 * nothing, so a checkout that got further than the customer thought goes
 * where it really stands rather than being told it was cancelled.
 */
export function pageShows(page: CheckoutPage, status: CheckoutStatus): boolean {
  if (page === 'cancelled') return pageForStatus(status) === 'payment-required';
  return pageForStatus(status) === page;
}

/** The locale-free path of a checkout page, for `Link` / `redirect` / `router`. */
export function checkoutPagePath(page: CheckoutPage): `/checkout/${CheckoutPage}` {
  return `/checkout/${page}`;
}

/** `ref` from a page's query: one string that is a checkout reference, else null. */
export function referenceFrom(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.startsWith('chk_') ? value : null;
}
