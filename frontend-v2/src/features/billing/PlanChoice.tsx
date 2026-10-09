import { Check } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import type { PaymentMethod } from '@/api/contracts/billing-profile';
import type { Subscription } from '@/api/contracts/billing';
import { creditsGrantedOnUpgrade, type CatalogPlan } from '@/api/contracts/pricing';
import { Link } from '@/i18n/navigation';

import styles from './Billing.module.css';
import { billingWritesEnabled } from '@/api/client/billing-writes';
import { HeldConfirm } from './HeldConfirm';
import { PlanSwitch } from './PlanSwitch';

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
 * 02's button column. The switch opens its confirm - what it would do, from
 * what `changePlan` proves - and holds there: dev's billing is the production
 * payment account, so its Yes is a status (HeldConfirm). "Keep" is the way back.
 *
 * What `changePlan` does (billing subscription.service):
 *   - moving UP charges the stored card NOW, the full difference between the
 *     two monthly prices (not by days), before VAT - unless on a trial, when
 *     nothing is charged and the price starts when the trial ends;
 *   - moving DOWN charges nothing and takes effect at the period's end.
 * No amount is printed: only the server can state the charged one (preview
 * route asked for, held with Omer).
 */
export async function SwitchActions({
  target,
  current,
  methods,
  subscription = null,
}: {
  readonly target: CatalogPlan | null;
  readonly current: CatalogPlan | null;
  readonly methods: readonly PaymentMethod[] | null;
  readonly subscription?: Subscription | null;
}) {
  const t = await getTranslations('billing.choice');
  const th = await getTranslations('billing.held');
  // On: the live switch (preview, then the exact charge). Off (dev): held, with why.
  const live = billingWritesEnabled();
  const locale = await getLocale();
  const card = methods && methods.length > 0 ? methods[0]! : null;
  const nameOf = (plan: CatalogPlan) => (locale === 'he' && plan.nameHe ? plan.nameHe : plan.name);

  const sentences = (plan: CatalogPlan): string[] => {
    const price = priceOf(plan, locale);
    const to = amountOf(plan);
    const from = current ? amountOf(current) : null;
    const date = subscription?.currentPeriodEnd
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
          new Date(subscription.currentPeriodEnd),
        )
      : null;
    if (to !== null && from !== null && to < from) {
      return [
        date
          ? t('confirm.down', { plan: nameOf(plan), current: nameOf(current!), date })
          : t('confirm.downNoDate', { plan: nameOf(plan), current: nameOf(current!) }),
        ...(price ? [t('confirm.thenPrice', { price })] : []),
      ];
    }
    if (to !== null && from !== null && to === from) return [t('confirm.samePrice')];
    if (subscription?.status === 'TRIALING') {
      return [
        t('confirm.trial', { plan: nameOf(plan) }),
        ...(price ? [t('confirm.thenPrice', { price })] : []),
      ];
    }
    if (methods !== null && !card) return [t('confirm.upNoCard')];
    return [
      card
        ? t('confirm.up', {
            plan: nameOf(plan),
            brand: card.brand ?? t('card'),
            last4: card.last4 ?? '-',
          })
        : t('confirm.upCardUnknown', { plan: nameOf(plan) }),
      ...(price ? [t('confirm.thenPrice', { price })] : []),
    ];
  };

  return (
    <div className={styles.switchActions} data-testid="switch-actions">
      {target && live ? (
        // Live (BILLING_WRITES=on): the server's preview, then the exact charge.
        <PlanSwitch
          planKey={target.key}
          planName={nameOf(target)}
          label={t('switchTo', { plan: nameOf(target) })}
          className={styles.switchButton}
        />
      ) : target ? (
        <HeldConfirm
          label={t('switchTo', { plan: nameOf(target) })}
          className={styles.switchButton}
          sentences={sentences(target)}
          yes={t('confirm.yes', { plan: nameOf(target) })}
          heldTag={th('tag')}
          heldWhy={th('why')}
          cancel={th('cancel')}
          testid="switch-button"
        />
      ) : (
        <span
          className={styles.switchButton}
          aria-disabled="true"
          title={t('summary.pick')}
          data-testid="switch-button"
        >
          {t('switch')}
        </span>
      )}
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
