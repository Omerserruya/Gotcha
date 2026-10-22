import 'server-only';

import type { CheckoutSummary } from '@/api/contracts/checkout';
import { redirect } from '@/i18n/navigation';

import { checkoutPagePath, pageForStatus, pageShows, type CheckoutPage } from './checkout-pages';
import { loadCheckout } from './load-checkout';

/** A page's query, as Next hands it. */
export type CheckoutQuery = Record<string, string | string[] | undefined>;

/**
 * The checkout a page shows, or `null` (the uniform unavailable state). A
 * status that belongs on another page is moved there, with only the
 * reference: the token never goes back into a URL.
 */
export async function checkoutFor(
  page: CheckoutPage,
  reference: string | null,
  locale: string,
): Promise<CheckoutSummary | null> {
  const read = await loadCheckout(reference);
  if (read.kind === 'unavailable' || !reference) return null;
  if (!pageShows(page, read.summary.status)) {
    redirect({
      href: {
        pathname: checkoutPagePath(pageForStatus(read.summary.status)),
        query: { ref: reference },
      },
      locale,
    });
  }
  return read.summary;
}
