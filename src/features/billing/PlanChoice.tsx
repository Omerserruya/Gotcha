import { Check } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import type { PaymentMethod } from '@/api/contracts/billing-profile';
import type { Subscription } from '@/api/contracts/billing';
import { creditsGrantedOnUpgrade, type CatalogPlan } from '@/api/contracts/pricing';
import { Link } from '@/i18n/navigation';

import styles from './Billing.module.css';

const FEATURES_SHOWN = 3;

function priceOf(plan: CatalogPlan, locale: string): string | null {
  if (!plan.basePrice) return null;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: plan.basePrice.display.currency,
    maximumFractionDigits: 0,
  }).format(Number(plan.basePrice.display.amount));
}

function amountOf(plan: CatalogPlan): number | null {
  return plan.basePrice ? Number(plan.basePrice.display.amount) : null;
}

/**
 * 17b's cards: every plan on offer, side by side. Yours is the dark one;
 * the one you picked has the heavy border. Picking is a link (`?plan=`) -
 * nothing is changed by choosing, only by the button under the summary.
 */
export async function PlanCards({
  catalog,
  currentKey,
  selectedKey,
}: {
  readonly catalog: readonly CatalogPlan[];
  readonly currentKey: string | null;
  readonly selectedKey: string | null;
}) {
  const t = await getTranslations('billing.choice');
  const locale = await getLocale();
  const number = new Intl.NumberFormat(locale);

  if (catalog.length === 0) {
    return (
      <p className={styles.choiceNone} data-testid="plan-cards-none" title={t('noCatalog')}>
        -
      </p>
    );
  }

  return (
    <ul className={styles.choiceCards} data-testid="plan-cards">
      {catalog.map((plan) => {
        const current = plan.key === currentKey;
        const selected = !current && plan.key === selectedKey;
        const price = priceOf(plan, locale);
        /*
          Only an estimate FROM the credits is drawn beside them. The default
          sold volume is the same 250 on 750 and on 7,000 credits, and beside
          the credits it reads as "more credits buy the same thing".
        */
        const chats =
          plan.estimate?.chat?.basis === 'CREDIT_RATIO'
            ? (plan.estimate.chat.monthly ?? null)
            : null;
        const features = plan.features.filter((f) => f.included).slice(0, FEATURES_SHOWN);
        const body = (
          <>
            {current ? (
              <span className={styles.choiceTagMine}>{t('yours')}</span>
            ) : selected ? (
              <span className={styles.choiceTagSelected}>{t('selected')}</span>
            ) : null}
            <span className={styles.choiceNameRow}>
              <span className={styles.choiceRadio} aria-hidden="true" />
              <span className={styles.choiceName}>
                {locale === 'he' && plan.nameHe ? plan.nameHe : plan.name}
              </span>
            </span>
            <span className={styles.choicePriceRow}>
              <span className={styles.choicePrice}>{price ?? '-'}</span>
              {price && plan.billingInterval?.toUpperCase() === 'MONTHLY' ? (
                <span className={styles.choicePer}>{t('perMonth')}</span>
              ) : null}
            </span>
            <span className={styles.choiceCredits}>
              {chats != null
                ? t('creditsAndChats', {
                    credits: number.format(plan.includedCredits),
                    chats: number.format(chats),
                  })
                : t('credits', { credits: number.format(plan.includedCredits) })}
            </span>
            {features.length > 0 ? (
              <span className={styles.choiceFeatures}>
                {features.map((f) => (
                  <span key={f.key} className={styles.choiceFeature}>
                    <Check size={13} aria-hidden="true" />
                    {locale === 'he' && f.nameHe ? f.nameHe : f.nameEn}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        );
        return (
          <li key={plan.key} className={styles.choiceItem}>
            {current ? (
              <div
                className={styles.choiceCard}
                data-kind="current"
                data-testid={`plan-card-${plan.key}`}
              >
                {body}
              </div>
            ) : (
              <Link
                href={{ pathname: '/settings/billing/plan', query: { plan: plan.key } }}
                className={styles.choiceCard}
                data-kind={selected ? 'selected' : 'other'}
                aria-current={selected ? 'true' : undefined}
                data-testid={`plan-card-${plan.key}`}
                scroll={false}
              >
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "What happens if you switch today", worked out from the catalog and the
 * subscription - not a quote. A move down takes effect at renewal and costs
 * nothing now (`changePlan` writes `effectiveAt` = the period end). A move up
 * is charged now, prorated, and only the server works that out: "-" until
 * the switch is real.
 */
export async function SwitchSummary({
  target,
  current,
  subscription,
}: {
  readonly target: CatalogPlan | null;
  readonly current: CatalogPlan | null;
  readonly subscription: Subscription | null;
}) {
  const t = await getTranslations('billing.choice');
  const locale = await getLocale();
  const number = new Intl.NumberFormat(locale);

  if (!target) {
    return (
      <section className={styles.summary} data-testid="switch-summary">
        <h2 className={styles.summaryTitle}>{t('summary.title')}</h2>
        <p className={styles.summaryNone}>{t('summary.pick')}</p>
      </section>
    );
  }

  const targetAmount = amountOf(target);
  const currentAmount = current ? amountOf(current) : null;
  const down = targetAmount != null && currentAmount != null && targetAmount < currentAmount;
  const renewal = subscription?.currentPeriodEnd
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
        new Date(subscription.currentPeriodEnd),
      )
    : null;
  const price = priceOf(target, locale);

  const rows: { key: string; label: string; value: string; note?: string; title?: string }[] = down
    ? [
        {
          key: 'charged',
          label: t('summary.chargedNow'),
          value: t('summary.nothing'),
          note: t('summary.downNote'),
        },
        { key: 'credits', label: t('summary.creditsNow'), value: t('summary.none') },
        {
          key: 'from',
          label: renewal ? t('summary.from', { date: renewal }) : t('summary.atRenewal'),
          value: price ? t('summary.perMonth', { price }) : '-',
          note: t('summary.eachCycle', { credits: number.format(target.includedCredits) }),
        },
      ]
    : [
        {
          key: 'charged',
          label: t('summary.chargedNow'),
          value: '-',
          title: t('summary.prorated'),
        },
        {
          key: 'credits',
          label: t('summary.creditsNow'),
          value: current
            ? `+ ${number.format(creditsGrantedOnUpgrade(target.includedCredits, current.includedCredits))}`
            : '-',
        },
        {
          key: 'from',
          label: t('summary.fromToday'),
          value: price ? t('summary.perMonth', { price }) : '-',
          note: t('summary.eachCycle', { credits: number.format(target.includedCredits) }),
        },
      ];

  return (
    <section
      className={styles.summary}
      data-testid="switch-summary"
      data-direction={down ? 'down' : 'up'}
    >
      <h2 className={styles.summaryTitle}>{t('summary.title')}</h2>
      {rows.map((row) => (
        <p key={row.key} className={styles.summaryRow} data-testid={`switch-${row.key}`}>
          <span className={styles.summaryLabel}>{row.label}</span>
          <span className={styles.summaryValue} title={row.title}>
            {row.value}
          </span>
          {row.note ? <span className={styles.summaryNote}>{row.note}</span> : null}
        </p>
      ))}
    </section>
  );
}

/**
 * 02's button column. The switch is drawn and not live: nothing on this
 * screen writes a plan change yet, and the one that does moves money - it
 * waits on Omer. "Keep" is the way back.
 */
export async function SwitchActions({
  target,
  current,
  methods,
}: {
  readonly target: CatalogPlan | null;
  readonly current: CatalogPlan | null;
  readonly methods: readonly PaymentMethod[] | null;
}) {
  const t = await getTranslations('billing.choice');
  const locale = await getLocale();
  const card = methods && methods.length > 0 ? methods[0]! : null;

  return (
    <div className={styles.switchActions} data-testid="switch-actions">
      <span
        className={styles.switchButton}
        aria-disabled="true"
        title={t('switchNotYet')}
        data-testid="switch-button"
      >
        {target
          ? t('switchTo', { plan: locale === 'he' && target.nameHe ? target.nameHe : target.name })
          : t('switch')}
      </span>
      <Link href="/settings/billing" className={styles.switchKeep} data-testid="switch-keep">
        {current
          ? t('keep', { plan: locale === 'he' && current.nameHe ? current.nameHe : current.name })
          : t('keepCurrent')}
      </Link>
      <p className={styles.switchFine} data-testid="switch-fine">
        {methods === null
          ? null
          : card
            ? t('chargedTo', { brand: card.brand ?? t('card'), last4: card.last4 ?? '-' })
            : t('noCard')}{' '}
        {t('downAtRenewal')}
      </p>
    </div>
  );
}
