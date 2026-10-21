import { getTranslations } from 'next-intl/server';

import { CheckoutFrame } from '@/features/checkout/CheckoutFrame';
import { CheckoutUnavailable } from '@/features/checkout/CheckoutUnavailable';
import { checkoutFor, type CheckoutQuery } from '@/features/checkout/checkout-for';
import { checkoutPagePath, referenceFrom } from '@/features/checkout/checkout-pages';
import styles from '@/features/checkout/Checkout.module.css';
import { Link } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The provider's Cancel (`/checkout/cancelled?ref=`, billing
 * `checkout-session.ts:94`). Nothing happened, and that is the message: the
 * checkout still asks for payment. If billing says it got further than that,
 * the visitor is moved to where it really stands rather than told here that
 * they cancelled something that went through.
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
  const summary = await checkoutFor('cancelled', reference, locale);
  if (!summary || !reference) return <CheckoutUnavailable />;
  const t = await getTranslations('checkout.cancelled');
  return (
    <CheckoutFrame title={t('title')} lead={t('lead')} testid="checkout-cancelled">
      <p className={styles.actions}>
        <Link
          href={{ pathname: checkoutPagePath('payment-required'), query: { ref: reference } }}
          className={styles.primary}
          data-testid="checkout-back-to-payment"
        >
          {t('tryAgain')}
        </Link>
      </p>
    </CheckoutFrame>
  );
}

export const generateMetadata = pageMetadata('tabTitle', 'checkout');
