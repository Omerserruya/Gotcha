import { getTranslations } from 'next-intl/server';

import { CheckoutFrame, SUPPORT_MAILTO } from '@/features/checkout/CheckoutFrame';
import { CheckoutUnavailable } from '@/features/checkout/CheckoutUnavailable';
import { checkoutFor, type CheckoutQuery } from '@/features/checkout/checkout-for';
import { referenceFrom } from '@/features/checkout/checkout-pages';
import styles from '@/features/checkout/Checkout.module.css';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The offer ran out. A new link is an admin's deliberate act - reissuing
 * would silently make a new commercial offer - so the way on is to ask.
 *
 * With a reference, shown only when billing says EXPIRED. Without one it is
 * where a signed-in member's expired checkout is sent (`/checkout/mine`
 * answers `expired: true` and no reference); saying "expired" there tells a
 * stranger nothing.
 */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ locale: string }>;
  readonly searchParams?: Promise<CheckoutQuery>;
}) {
  const { locale } = await params;
  const reference = referenceFrom(((await searchParams) ?? {}).ref);
  if (reference && !(await checkoutFor('expired', reference, locale))) {
    return <CheckoutUnavailable />;
  }
  const t = await getTranslations('checkout');
  return (
    <CheckoutFrame title={t('expired.title')} lead={t('expired.lead')} testid="checkout-expired">
      <p className={styles.actions}>
        <a className={styles.secondary} href={SUPPORT_MAILTO} data-testid="checkout-new-link">
          {t('expired.requestNewLink')}
        </a>
      </p>
    </CheckoutFrame>
  );
}

export const generateMetadata = pageMetadata('tabTitle', 'checkout');
