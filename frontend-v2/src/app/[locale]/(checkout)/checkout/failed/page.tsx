import { getTranslations } from 'next-intl/server';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { CheckoutFrame, SUPPORT_MAILTO } from '@/features/checkout/CheckoutFrame';
import { CheckoutUnavailable } from '@/features/checkout/CheckoutUnavailable';
import { checkoutFor, type CheckoutQuery } from '@/features/checkout/checkout-for';
import { referenceFrom } from '@/features/checkout/checkout-pages';
import { PayButton } from '@/features/checkout/PayButton';
import { SummaryCard } from '@/features/checkout/SummaryCard';
import styles from '@/features/checkout/Checkout.module.css';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The provider's failure return (`/checkout/failed?ref=`, billing
 * `checkout-session.ts:91`), shown only when billing says FAILED. No decline
 * text, no provider code. Try again is offered only where billing says a retry
 * cannot charge twice (`retryEligible`) and payment can be set up at all.
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
  const summary = await checkoutFor('failed', reference, locale);
  if (!summary || !reference) return <CheckoutUnavailable />;
  const t = await getTranslations('checkout');
  return (
    <CheckoutFrame title={t('failed.title')} lead={t('failed.lead')} testid="checkout-failed">
      <SummaryCard summary={summary} />
      {summary.retryEligible && summary.paymentSetupAvailable ? (
        <PayButton
          reference={reference}
          label={t('failed.tryAgain')}
          live={billingWritesEnabled()}
        />
      ) : null}
      <p className={styles.actions}>
        <a className={styles.secondary} href={SUPPORT_MAILTO} data-testid="checkout-support">
          {t('support')}
        </a>
      </p>
    </CheckoutFrame>
  );
}

export const generateMetadata = pageMetadata('tabTitle', 'checkout');
