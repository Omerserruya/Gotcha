import { getTranslations } from 'next-intl/server';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { CheckoutFrame } from '@/features/checkout/CheckoutFrame';
import { CheckoutUnavailable } from '@/features/checkout/CheckoutUnavailable';
import { checkoutFor, type CheckoutQuery } from '@/features/checkout/checkout-for';
import { checkoutPagePath, referenceFrom } from '@/features/checkout/checkout-pages';
import { loadMine } from '@/features/checkout/load-checkout';
import { PayButton } from '@/features/checkout/PayButton';
import { SummaryCard } from '@/features/checkout/SummaryCard';
import styles from '@/features/checkout/Checkout.module.css';
import { redirect } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * "One step left": the plan, its price, and the way to the provider's card
 * page. Reached from the emailed link, from the provider's Cancel, and from
 * the product's payment gate - which may know no reference (the platform's
 * 402 names `/checkout/payment-required` bare), so a signed-in member's own
 * outstanding checkout is looked up.
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

  if (!reference) {
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

  const summary = await checkoutFor('payment-required', reference, locale);
  if (!summary) return <CheckoutUnavailable />;
  const t = await getTranslations('checkout.paymentRequired');
  const declined = summary.declineCategory;

  return (
    <CheckoutFrame title={t('title')} lead={t('lead')} testid="checkout-payment-required">
      {/*
        A refusal is said before asking again: without it "one step left"
        greets someone whose card was just declined, and they retry the same
        card. "Try another" only where they can.
      */}
      {declined ? (
        <p className={styles.declined} role="status" data-testid="checkout-declined">
          {t(`declined.${declined}`)}
          {summary.paymentSetupAvailable ? ` ${t('declined.tryAnother')}` : ''}
        </p>
      ) : null}
      <SummaryCard summary={summary} />
      {summary.paymentSetupAvailable ? (
        <PayButton
          reference={reference}
          label={declined ? t('retry') : t('start')}
          live={billingWritesEnabled()}
        />
      ) : (
        <p className={styles.quiet} data-testid="checkout-not-yet">
          {t('notYet')}
        </p>
      )}
    </CheckoutFrame>
  );
}

export const generateMetadata = pageMetadata('tabTitle', 'checkout');
