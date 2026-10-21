import { getTranslations } from 'next-intl/server';

import { CheckoutFrame } from '@/features/checkout/CheckoutFrame';
import { CheckoutUnavailable } from '@/features/checkout/CheckoutUnavailable';
import { checkoutFor, type CheckoutQuery } from '@/features/checkout/checkout-for';
import { referenceFrom } from '@/features/checkout/checkout-pages';
import { ResendWelcome } from '@/features/checkout/ResendWelcome';
import { SummaryCard } from '@/features/checkout/SummaryCard';
import styles from '@/features/checkout/Checkout.module.css';
import { Link } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Paid - only when billing says COMPLETED. The way on is the product: a
 * member goes in (setup first, if it is not done - the product's gate decides
 * that), anyone else signs in first and comes back to it.
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
  const summary = await checkoutFor('completed', reference, locale);
  if (!summary || !reference) return <CheckoutUnavailable />;
  const t = await getTranslations('checkout.completed');
  return (
    <CheckoutFrame title={t('title')} lead={t('lead')} testid="checkout-completed">
      <SummaryCard summary={summary} />
      <p className={styles.actions}>
        <Link href="/home" className={styles.primary} data-testid="checkout-continue">
          {t('continue')}
        </Link>
      </p>
      <ResendWelcome reference={reference} />
    </CheckoutFrame>
  );
}

export const generateMetadata = pageMetadata('tabTitle', 'checkout');
