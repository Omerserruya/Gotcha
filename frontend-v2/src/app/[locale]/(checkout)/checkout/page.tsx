import { CheckoutOpen } from '@/features/checkout/CheckoutOpen';
import { CheckoutUnavailable } from '@/features/checkout/CheckoutUnavailable';
import type { CheckoutQuery } from '@/features/checkout/checkout-for';
import { checkoutPagePath, pageForStatus, referenceFrom } from '@/features/checkout/checkout-pages';
import { loadCheckout, loadMine } from '@/features/checkout/load-checkout';
import { redirect } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Where the payment email lands (`/checkout?ref=&token=`, auth
 * `notification.service.ts:875`), and the product's fallback when it knows
 * no reference. It decides nothing itself: it hands over to the page billing
 * says the checkout belongs on.
 *
 *   ref + token   the emailed link: the token is taken out of the URL and
 *                 kept server-side (`CheckoutOpen`)
 *   ref           a link already opened here, or a member's own
 *   nothing       a signed-in member's outstanding checkout, if any
 */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams?: Promise<CheckoutQuery>;
}) {
  const { locale } = await params;
  const q = (await searchParams) ?? {};
  const reference = referenceFrom(q.ref);
  const token = typeof q.token === 'string' && q.token !== '' ? q.token : null;

  if (reference && token) return <CheckoutOpen reference={reference} token={token} />;

  if (reference) {
    const read = await loadCheckout(reference);
    if (read.kind === 'ready') {
      redirect({
        href: {
          pathname: checkoutPagePath(pageForStatus(read.summary.status)),
          query: { ref: reference },
        },
        locale,
      });
    }
    return <CheckoutUnavailable />;
  }

  const mine = await loadMine();
  if (mine.kind === 'open') {
    redirect({
      href: { pathname: checkoutPagePath('payment-required'), query: { ref: mine.reference } },
      locale,
    });
  }
  if (mine.kind === 'expired') redirect({ href: checkoutPagePath('expired'), locale });
  return <CheckoutUnavailable />;
}

export const generateMetadata = pageMetadata('tabTitle', 'checkout');
