import { getLocale, getTranslations } from 'next-intl/server';

import {
  hasSomethingToCharge,
  profileReading,
  type BillingProfile,
  type PaymentMethod,
} from '@/api/contracts/billing-profile';
import { spendsPastZero, type AutoPurchase as Policy } from '@/api/contracts/auto-purchase';
import {
  planNameFor,
  pricePer,
  type Plan,
  type Subscription,
  type UsageBreakdown,
} from '@/api/contracts/billing';
import type { CreditSummary } from '@/api/contracts/credits';
import { failedInvoices, totalAmount, type Invoice } from '@/api/contracts/invoices';
import { isStillPending } from '@/api/contracts/pricing';
import { Link } from '@/i18n/navigation';

import styles from './Billing.module.css';

/**
 * 17's plan, up front and dark: what you are on, what it costs, what comes
 * with it, and the two ways out of it - Change plan (17b) and Buy credits
 * (17d).
 *
 * **The currency is whatever the subscription carries** - the demo tenant is
 * charged `$1,499.00 USD`, not 02's `₪1,290`. 02's "3 AI employees · All
 * channels" are not on any plan read, so they are not drawn.
 */
export async function PlanHero({
  subscription,
  plans,
  credits,
}: {
  readonly subscription: Subscription | null;
  readonly plans: readonly Plan[];
  readonly credits: CreditSummary | null;
}) {
  const t = await getTranslations('billing.overview');
  const locale = await getLocale();
  const now = new Date();

  const date = (iso: string) => {
    const at = new Date(iso);
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }).format(at);
  };

  const price =
    subscription?.snapshotPrice != null && subscription.snapshotCurrency
      ? new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: subscription.snapshotCurrency,
          maximumFractionDigits: 0,
        }).format(Number(subscription.snapshotPrice))
      : null;
  const per = subscription ? pricePer(subscription) : null;
  const included = credits?.plan.includedCredits ?? 0;

  return (
    <section className={styles.hero} data-testid="plan-hero">
      <div className={styles.heroMain}>
        <p className={styles.heroTagRow}>
          <span className={styles.heroTag}>{t('yourPlan')}</span>
          {subscription?.createdAt ? (
            <span className={styles.heroSince} data-testid="plan-since">
              {t('since', {
                date: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
                  new Date(subscription.createdAt),
                ),
              })}
            </span>
          ) : null}
        </p>

        {subscription ? (
          <>
            <p className={styles.heroNameRow}>
              {/*
                The plan's NAME, not its key - the key only when the plan is
                not in the list at all: an unrecognised plan is still the one
                they are paying for.
              */}
              <span className={styles.heroName} data-testid="plan-name">
                {planNameFor(plans, subscription.planKey, locale) ?? subscription.planKey}
              </span>
              {price ? (
                <span className={styles.heroPrice} data-testid="plan-price">
                  {per ? t(`per.${per}`, { price }) : price}
                </span>
              ) : null}
            </p>
            <p className={styles.heroFacts}>
              {included > 0 ? <span>{t('included', { credits: included })}</span> : null}
              {/* Ending and renewing are opposite facts about the same date. */}
              {subscription.currentPeriodEnd ? (
                <span data-testid="plan-renews">
                  {subscription.cancelAtPeriodEnd
                    ? t('ends', { date: date(subscription.currentPeriodEnd) })
                    : t('renews', { date: date(subscription.currentPeriodEnd) })}
                </span>
              ) : null}
              {/*
                `isStillPending`, not truthiness: the scheduler marks
                `appliedAt` and never deletes the row, so a change applied a
                year ago would otherwise say "changes at renewal" forever.
              */}
              {isStillPending(subscription.pendingChange) &&
              subscription.pendingChange?.targetPlanKey ? (
                <span data-testid="plan-pending">
                  {t('changes', {
                    plan:
                      planNameFor(plans, subscription.pendingChange.targetPlanKey, locale) ??
                      subscription.pendingChange.targetPlanKey,
                  })}
                </span>
              ) : null}
            </p>
          </>
        ) : (
          <p className={styles.heroName} data-testid="plan-unavailable" title={t('planUnread')}>
            -
          </p>
        )}
      </div>

      <div className={styles.heroActions}>
        <Link href="/settings/billing/plan" className={styles.heroChange} data-testid="plan-change">
          {t('changePlan')}
        </Link>
        <Link
          href={{ pathname: '/settings/billing', query: { panel: 'buy' } }}
          className={styles.heroBuy}
          data-testid="plan-buy"
        >
          {t('buyCredits')}
        </Link>
      </div>
    </section>
  );
}

/** 02's four kinds of work, each tied to the figure that counts it. */
const KINDS = [
  { key: 'ai', count: 'handledByAi' },
  { key: 'team', count: 'handledByPeople' },
  { key: 'outbound', count: 'outboundMessages' },
  { key: 'voice', count: 'voiceMinutes' },
] as const;

/**
 * "Where credits went" - each kind of work with its average cost, its count
 * and its credits, so the estimate above can be checked.
 *
 * Nothing serves credits per kind of work, so the average and the credits are
 * "-" on every row; the count is drawn where the breakdown has it. The rows
 * are drawn either way: a missing figure is "-", never zero, because "no
 * outbound messages" and "we did not count" are different, and on a billing
 * screen the difference is money.
 */
export async function CreditsWent({ breakdown }: { readonly breakdown: UsageBreakdown | null }) {
  const t = await getTranslations('billing.overview');
  const locale = await getLocale();
  const number = new Intl.NumberFormat(locale);

  return (
    <section className={styles.went} data-testid="breakdown">
      <header className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t('went.title')}</h2>
        <span className={styles.cardHeadNote}>{t('went.columns')}</span>
      </header>
      <ul className={styles.wentRows}>
        {KINDS.map(({ key, count }) => {
          const n = breakdown?.[count] ?? null;
          return (
            <li key={key} className={styles.wentRow} data-testid={`breakdown-${key}`}>
              <span className={styles.wentName}>{t(`went.kind.${key}`)}</span>
              <span className={styles.wentAvg} title={t('went.noCredits')}>
                -
              </span>
              <span className={styles.wentCount} data-testid={`breakdown-${key}-count`}>
                {n === null ? '-' : number.format(n)}
              </span>
              <span className={styles.wentCredits} title={t('went.noCredits')}>
                -
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * "When credits run low" - the rule in one sentence and its ceiling; the rule
 * itself is 17c, behind Change.
 */
export async function RunningLow({
  policy,
  currency,
}: {
  readonly policy: Policy | null;
  readonly currency: string;
}) {
  const t = await getTranslations('billing.overview');
  const locale = await getLocale();
  const money = (amount: string | number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(
      Number(amount),
    );

  return (
    <section className={styles.lowCard} data-testid="running-low">
      <header className={styles.lowHead}>
        <h2 className={styles.cardTitle}>{t('low.title')}</h2>
        <Link
          href={{ pathname: '/settings/billing', query: { panel: 'low' } }}
          className={styles.underlineLink}
          data-testid="running-low-change"
        >
          {t('change')}
        </Link>
      </header>
      <p className={styles.lowRule} data-testid="running-low-rule">
        {policy === null
          ? t('low.unset')
          : policy.enabled
            ? t('low.buys', { threshold: policy.thresholdPct })
            : t('low.off')}
      </p>
      {policy?.maxMonthlySpend != null ? (
        <p className={styles.lowCap} data-testid="running-low-cap">
          {t('low.cap', { cap: money(policy.maxMonthlySpend) })}
        </p>
      ) : null}
      {/* A cap with pay-as-you-go stops the auto-purchase, not the bill. */}
      {policy?.maxMonthlySpend != null && spendsPastZero(policy.limitBehavior) ? (
        <p className={styles.alertLine} data-testid="running-low-not-a-cap">
          {t('low.notACap')}
        </p>
      ) : null}
    </section>
  );
}

/**
 * "Billing" - card, who is invoiced, where receipts go, the last invoices. The
 * details themselves are 17e, behind Edit details; every invoice is its own
 * page, behind All.
 */
export async function BillingCard({
  profile,
  methods,
  invoices,
}: {
  readonly profile: BillingProfile | null;
  readonly methods: readonly PaymentMethod[] | null;
  readonly invoices: readonly Invoice[] | null;
}) {
  const t = await getTranslations('billing.overview');
  const locale = await getLocale();
  const reading = profileReading(profile);
  const present = reading === 'filled';
  const month = new Intl.DateTimeFormat(locale, { month: 'short' });

  const card =
    methods === null
      ? { text: '-', title: t('billing.cardUnread') }
      : methods.length === 0 || !hasSomethingToCharge(methods)
        ? { text: t('billing.noCard'), title: undefined }
        : {
            text: t('billing.card', {
              brand: methods[0]!.brand ?? t('billing.cardBrand'),
              last4: methods[0]!.last4 ?? '-',
            }),
            title: undefined,
          };

  const invoicedTo = present
    ? [profile?.billingName, profile?.vatId].filter(Boolean).join(' · ') || null
    : null;

  /*
    Each recent invoice with its state when it is not paid: a failed renewal
    shown as "Sep $1,499" reads as a paid one (measured on dev: three failed
    ai_voice renewals). Paid is the amount alone.
  */
  const invoiceState = await getTranslations('billing.invoices.status');
  const recent = (invoices ?? []).slice(0, 3).map((invoice) => {
    const when = invoice.issuedAt ?? invoice.createdAt;
    const amount = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: invoice.currency,
      maximumFractionDigits: 0,
    }).format(Number(invoice.amount));
    return {
      id: invoice.id,
      text: when ? `${month.format(new Date(when))} ${amount}` : amount,
      status: invoice.status === 'PAID' ? null : invoice.status,
    };
  });

  /*
    The one alert this card carries, in the order that decides what to do:
    nothing to charge, then charges that already failed. Red, because both
    are true trouble.
  */
  const failed = invoices === null ? null : failedInvoices(invoices);
  const alert =
    methods !== null && !hasSomethingToCharge(methods) && failed !== null && failed.length > 0
      ? t('billing.noCardFailed', { count: failed.length })
      : failed !== null && failed.length > 0
        ? t('billing.failed', {
            count: failed.length,
            total: totalAmount(failed),
            currency: failed[0]!.currency,
          })
        : null;

  return (
    <section className={styles.billingCard} data-testid="billing-card">
      <header className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t('billing.title')}</h2>
        <Link
          href={{ pathname: '/settings/billing', query: { panel: 'details' } }}
          className={styles.underlineLink}
          data-testid="billing-edit"
        >
          {t('billing.edit')}
        </Link>
      </header>
      <dl className={styles.billingRows}>
        <div className={styles.billingRow} data-testid="billing-row-card">
          <dt>{t('billing.cardLabel')}</dt>
          <dd title={card.title}>{card.text}</dd>
        </div>
        <div className={styles.billingRow} data-testid="billing-row-invoiced">
          <dt>{t('billing.invoicedTo')}</dt>
          <dd title={invoicedTo ? undefined : t(`billing.reading.${reading}`)}>
            {invoicedTo ?? '-'}
          </dd>
        </div>
        <div className={styles.billingRow} data-testid="billing-row-receipts">
          <dt>{t('billing.receiptsTo')}</dt>
          <dd
            title={present && profile?.billingEmail ? undefined : t(`billing.reading.${reading}`)}
          >
            {(present && profile?.billingEmail) || '-'}
          </dd>
        </div>
        <div className={styles.billingRow} data-testid="billing-row-invoices">
          <dt>{t('billing.invoices')}</dt>
          <dd title={invoices === null ? t('billing.invoicesUnread') : undefined}>
            {invoices === null
              ? '-'
              : recent.length > 0
                ? recent.map((item, i) => (
                    <span key={item.id} data-testid={`billing-invoice-${item.id}`}>
                      {i > 0 ? ' · ' : ''}
                      {item.text}
                      {item.status ? (
                        <span
                          className={styles.invoiceState}
                          data-status={item.status}
                        >{` ${invoiceState(item.status)}`}</span>
                      ) : null}
                    </span>
                  ))
                : t('billing.none')}
          </dd>
          {invoices !== null && invoices.length > 0 ? (
            <Link
              href="/settings/billing/invoices"
              className={styles.billingAll}
              data-testid="billing-invoices-all"
            >
              {t('billing.all')}
            </Link>
          ) : null}
        </div>
      </dl>
      {alert ? (
        <p className={styles.billingAlert} data-testid="billing-alert">
          {alert}
        </p>
      ) : null}
    </section>
  );
}

/**
 * 02's value line - hours your team did not spend, and revenue from
 * outreach. Nothing computes either, so the line is drawn with "-".
 */
export async function CycleValue() {
  const t = await getTranslations('billing.overview');
  return (
    <p className={styles.cycleValue} data-testid="cycle-value" title={t('value.none')}>
      <span className={styles.cycleValueLabel}>{t('value.label')}</span> · -
    </p>
  );
}

/**
 * 17d when the packages could not be read: 02's dialog in its shape - three
 * empty tiles, "Pay with" and a Pay button that cannot be pressed - with the
 * failed read said once. Never an empty dialog, never "none on sale".
 */
export async function BuyUnavailable({
  methods,
}: {
  readonly methods: readonly PaymentMethod[] | null;
}) {
  const t = await getTranslations('billing.overview.buyShape');
  const card = methods && methods.length > 0 ? methods[0]! : null;
  return (
    <div className={styles.buyShape} data-testid="buy-unavailable">
      <p className={styles.lowUnset}>{t('unread')}</p>
      <ul className={styles.buyShapeTiles} aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className={styles.buyShapeTile}>
            -
          </li>
        ))}
      </ul>
      <p className={styles.buyShapePay}>
        <span className={styles.buyShapeLabel}>{t('payWith')}</span>
        <span className={styles.buyShapeCard}>
          {methods === null
            ? '-'
            : card
              ? `${card.brand ?? t('card')} · ${card.last4 ?? '-'}`
              : t('noCard')}
        </span>
      </p>
      <span className={styles.overlayFootPrimary} aria-disabled="true" data-testid="buy-shape-pay">
        {t('pay')}
      </span>
    </div>
  );
}
