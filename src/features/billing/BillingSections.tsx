import { getLocale, getTranslations } from 'next-intl/server';

import type { BillingSummary, Subscription, UsageBreakdown } from '@/api/contracts/billing';

import styles from './Billing.module.css';

/**
 * The plan, its price, and when it renews.
 *
 * **The currency is whatever the subscription carries** — the demo tenant is
 * charged `$1,499.00 USD`, not the design's `₪1,290`. That number is a mockup,
 * and converting it or showing a symbol the row does not have would put a
 * price in front of somebody that nobody agreed to.
 *
 * `cancelAtPeriodEnd` and a scheduled `pendingChange` are both rendered,
 * because "renews on the 8th" and "ends on the 8th" are opposite facts that
 * would otherwise look identical.
 */
export async function PlanLine({ subscription }: { readonly subscription: Subscription | null }) {
  const t = await getTranslations('billing');
  const locale = await getLocale();

  if (!subscription) {
    return (
      <p className={styles.unavailable} data-testid="plan-unavailable">
        {t('plan.unavailable')}
      </p>
    );
  }

  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const price =
    subscription.snapshotPrice != null && subscription.snapshotCurrency
      ? new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: subscription.snapshotCurrency,
          maximumFractionDigits: 0,
        }).format(Number(subscription.snapshotPrice))
      : null;

  return (
    <div className={styles.plan} data-testid="plan">
      <p className={styles.planLine} data-testid="plan-line">
        <span className={styles.planName}>{subscription.planKey}</span>
        {price ? <span className={styles.planPrice}>{price}</span> : null}
        {subscription.currentPeriodEnd ? (
          <span className={styles.planRenews}>
            {/*
              Ending and renewing are opposite facts about the same date, and
              a line that says only "12 September" tells you neither.
            */}
            {subscription.cancelAtPeriodEnd
              ? t('plan.endsOn', { date: day.format(new Date(subscription.currentPeriodEnd)) })
              : t('plan.renewsOn', { date: day.format(new Date(subscription.currentPeriodEnd)) })}
          </span>
        ) : null}
      </p>

      {subscription.pendingChange?.targetPlanKey ? (
        <p className={styles.planNote} data-testid="plan-pending">
          {t('plan.changesAtRenewal', { plan: subscription.pendingChange.targetPlanKey })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * *"Where the month went."*
 *
 * Contracted and not yet served. Every piece exists — `Conversation.handledBy`
 * for the split, `Broadcast` for outbound, `VoiceCallSession` for minutes —
 * and nothing aggregates them.
 *
 * Each figure is independently nullable, because they come from different
 * places and a backend that can answer three of four should be able to say so.
 * A missing figure is omitted rather than shown as zero: "no outbound
 * messages" and "we did not count" are different, and on a billing screen the
 * difference is money.
 */
export async function UsageBreakdownSection({
  breakdown,
}: {
  readonly breakdown: UsageBreakdown | null;
}) {
  const t = await getTranslations('billing');
  const locale = await getLocale();

  if (!breakdown) {
    return (
      <p className={styles.unavailable} data-testid="breakdown-unavailable">
        {t('breakdown.unavailable')}
      </p>
    );
  }

  const number = new Intl.NumberFormat(locale);
  const rows: { key: string; label: string; value: string }[] = [];

  if (breakdown.handledByAi != null) {
    rows.push({
      key: 'ai',
      label: t('breakdown.byAi'),
      value: number.format(breakdown.handledByAi),
    });
  }
  if (breakdown.handledByPeople != null) {
    rows.push({
      key: 'people',
      label: t('breakdown.byPeople'),
      value: number.format(breakdown.handledByPeople),
    });
  }
  if (breakdown.outboundMessages != null) {
    rows.push({
      key: 'outbound',
      label: t('breakdown.outbound'),
      value: number.format(breakdown.outboundMessages),
    });
  }
  if (breakdown.voiceMinutes != null) {
    rows.push({
      key: 'voice',
      label: t('breakdown.voiceMinutes'),
      value:
        breakdown.voiceMinutesLimit != null
          ? t('breakdown.ofLimit', {
              used: number.format(breakdown.voiceMinutes),
              limit: number.format(breakdown.voiceMinutesLimit),
            })
          : number.format(breakdown.voiceMinutes),
    });
  }

  if (rows.length === 0) {
    return (
      <p className={styles.empty} data-testid="breakdown-empty">
        {t('breakdown.empty')}
      </p>
    );
  }

  return (
    <ul className={styles.rows} data-testid="breakdown">
      {rows.map((row) => (
        <li key={row.key} className={styles.row} data-testid={`breakdown-${row.key}`}>
          <span className={styles.rowLabel}>{row.label}</span>
          <span className={styles.rowValue}>{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Invoices and the card on file.
 *
 * Contracted and not yet served: `Invoice` carries everything the design draws
 * including `providerPdfUrl`, and no tenant-facing list route exists. Four real
 * invoices sit on the demo tenant, unreachable.
 *
 * **The overage sentence and the spending cap are absent entirely**, not
 * softened. There is no rate field and no cap field, so *"bills ₪0.40 per
 * extra conversation"* would be asserting billing behaviour from a mockup —
 * and a wrong claim about money belongs least of all on the billing screen.
 */
export async function Invoices({ summary }: { readonly summary: BillingSummary | null }) {
  const t = await getTranslations('billing');
  const locale = await getLocale();

  if (!summary) {
    return (
      <p className={styles.unavailable} data-testid="invoices-unavailable">
        {t('invoices.unavailable')}
      </p>
    );
  }

  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });

  return (
    <div className={styles.block} data-testid="invoices">
      {summary.paymentMethod?.last4 ? (
        <p className={styles.card} data-testid="payment-method">
          {t('invoices.card', {
            brand: summary.paymentMethod.brand ?? t('invoices.unknownBrand'),
            last4: summary.paymentMethod.last4,
          })}
        </p>
      ) : null}

      {summary.invoices.length === 0 ? (
        <p className={styles.empty} data-testid="invoices-empty">
          {t('invoices.empty')}
        </p>
      ) : (
        <ul className={styles.rows}>
          {summary.invoices.map((invoice) => (
            <li key={invoice.id} className={styles.row} data-testid={`invoice-${invoice.id}`}>
              <span className={styles.rowLabel}>
                {invoice.issuedAt ? day.format(new Date(invoice.issuedAt)) : t('invoices.undated')}
              </span>
              <span className={styles.rowValue}>
                {new Intl.NumberFormat(locale, {
                  style: 'currency',
                  currency: invoice.currency,
                  maximumFractionDigits: 0,
                }).format(Number(invoice.amount))}
              </span>
              {/*
                A link only when there is one to follow. An invoice that has
                not been issued has no PDF, and a dead "PDF" label is worse
                than none.
              */}
              {invoice.providerPdfUrl ? (
                <a
                  className={styles.pdf}
                  href={invoice.providerPdfUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('invoices.pdf')}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
