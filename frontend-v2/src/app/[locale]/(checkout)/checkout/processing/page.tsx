import { CheckoutUnavailable } from '@/features/checkout/CheckoutUnavailable';
import type { CheckoutQuery } from '@/features/checkout/checkout-for';
import { referenceFrom } from '@/features/checkout/checkout-pages';
import { loadCheckout } from '@/features/checkout/load-checkout';
import { ProcessingWatch } from '@/features/checkout/ProcessingWatch';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Where the provider sends a customer after the card page
 * (`/checkout/processing?ref=`, billing `checkout-session.ts:90`).
 *
 * Not moved on from here by the first read: billing has not yet been asked
 * to look at what the provider did, and a checkout the customer has just
 * paid can still read "payment required" until it is. The watcher asks
 * first, then moves.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<CheckoutQuery>;
}) {
  const q = (await searchParams) ?? {};
  const reference = referenceFrom(q.ref);
  const read = await loadCheckout(reference);
  if (!reference || read.kind === 'unavailable') return <CheckoutUnavailable />;
  return <ProcessingWatch reference={reference} initial={read.summary} />;
}

export const generateMetadata = pageMetadata('tabTitle', 'checkout');
