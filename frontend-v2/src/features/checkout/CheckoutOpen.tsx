'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useRouter } from '@/i18n/navigation';

import { openCheckout } from './actions';
import { checkoutPagePath } from './checkout-pages';
import { CheckoutFrame } from './CheckoutFrame';
import { CheckoutUnavailable } from './CheckoutUnavailable';

/**
 * The emailed link (`/checkout?ref=&token=`): take the token out of the
 * address bar before anything else, hand it to the server once, and go to the
 * page billing says the checkout belongs on.
 *
 * ★ The token is a bearer credential for the checkout - it shows the price,
 *   starts a payment and asks billing to charge. In the address bar it sits
 *   in history and in any screen-share; so it is removed in a layout effect,
 *   before paint, and from then on an HttpOnly cookie carries it.
 */
export function CheckoutOpen({
  reference,
  token,
}: {
  readonly reference: string;
  readonly token: string;
}) {
  const t = useTranslations('checkout.opening');
  const router = useRouter();
  const [gone, setGone] = useState(false);
  const asked = useRef(false);

  useLayoutEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', url.toString());
  }, []);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void openCheckout(reference, token).then((opened) => {
      if (!opened.ok) {
        setGone(true);
        return;
      }
      router.replace({ pathname: checkoutPagePath(opened.page), query: { ref: reference } });
    });
  }, [reference, token, router]);

  if (gone) return <CheckoutUnavailable />;
  return <CheckoutFrame title={t('title')} lead={t('lead')} testid="checkout-opening" />;
}
