import { useFormatter, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import type { CheckoutSummary } from '@/api/contracts/checkout';

import styles from './Checkout.module.css';

/**
 * What is being bought, from billing's summary. Nothing here is computed: a
 * missing figure is left out rather than drawn as a zero, which would misstate
 * the price.
 */
export function SummaryCard({ summary }: { readonly summary: CheckoutSummary }) {
  const t = useTranslations('checkout.summary');
  const format = useFormatter();
  const money = (amount: string, currency: string) => {
    const value = Number(amount);
    if (amount === '' || !Number.isFinite(value)) return null;
    try {
      return format.number(value, { style: 'currency', currency, maximumFractionDigits: 2 });
    } catch {
      return `${amount} ${currency}`;
    }
  };
  const recurring = money(summary.amount, summary.currency);
  const charge = summary.charge;
  /*
    Priced in dollars, debited in shekels: the shekel figure is what the
    customer will find on their statement, so it is said whenever it differs.
  */
  const converted = charge && charge.currency !== summary.currency ? charge : null;
  const charged = converted ? money(converted.amount, converted.currency) : null;
  const expires = summary.expiresAt ? new Date(summary.expiresAt) : null;

  return (
    <div className={styles.summary} data-testid="checkout-summary">
      {summary.organizationName ? (
        <p className={styles.organization}>
          <bdi>{summary.organizationName}</bdi>
        </p>
      ) : null}
      <dl>
        {summary.planName ? (
          <Line label={t('plan')} value={<bdi>{summary.planName}</bdi>} strong />
        ) : null}
        {recurring ? <Line label={t('recurring')} value={recurring} /> : null}
        {charged ? (
          <Line label={t('charged')} value={charged} strong testid="checkout-charged" />
        ) : null}
        <Line label={t('credits')} value={format.number(summary.includedCredits)} />
        <Line
          label={t('interval')}
          value={summary.billingInterval === 'ANNUAL' ? t('annual') : t('monthly')}
        />
        {/* Not reissued automatically: someone leaving this open overnight should know. */}
        {expires && Number.isFinite(expires.getTime()) ? (
          <Line
            label={t('offerValid')}
            value={format.dateTime(expires, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            })}
          />
        ) : null}
      </dl>
      {converted ? (
        <p className={styles.rate} data-testid="checkout-rate">
          {t(converted.settled ? 'rateSettled' : 'rateIndicative', {
            rate: converted.exchangeRate,
          })}
        </p>
      ) : null}
      <p className={styles.note}>{t('activation')}</p>
    </div>
  );
}

function Line({
  label,
  value,
  strong = false,
  testid,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly strong?: boolean;
  readonly testid?: string;
}) {
  return (
    <div className={styles.line} data-testid={testid}>
      <dt>{label}</dt>
      <dd className={strong ? styles.strong : undefined}>{value}</dd>
    </div>
  );
}
