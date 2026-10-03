import type { ReactNode } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';

import {
  capUsed,
  isSettable,
  spendsPastZero,
  type AutoPurchase as Policy,
} from '@/api/contracts/auto-purchase';

import styles from './Billing.module.css';

/**
 * Screen 17c — when credits run low, and what happens when you stop.
 *
 * ── THE FIVE BEHAVIOURS ARE NOT FIVE SETTINGS OF ONE THING ──
 * `STOP_AI` and `PAYG` are **opposite answers to the same question**: one
 * stops the product when the money runs out, the other keeps serving and
 * bills afterwards. Listing them as five equal options is accurate and
 * useless, so each is described by **what it does to the people using GOTCHA
 * tomorrow** rather than by what it is called.
 *
 * ── AND A CAP PLUS PAYG IS NOT A CAP ──
 * The design offers *"set a spending cap"*. With `PAYG` selected, usage past
 * zero is accrued and billed at the end of the cycle — **so the cap stops
 * auto-purchasing and does not stop the bill.** A merchant who sets a limit
 * and picks that behaviour has not done what they think they have done, and
 * this is the one combination the screen has to call out.
 *
 * ── TWO THRESHOLDS ──
 * `warningThresholdPct` tells the owner; `thresholdPct` buys. The design
 * draws one. **A warning that fires at the same moment as the action it warns
 * about is not a warning**, and a screen showing only the trigger hides that
 * somebody is told first.
 */
type Option = 'pack' | 'payg' | 'stop';

/** Which of 02's three answers the stored policy is. */
export function optionOf(policy: Policy): Option {
  if (policy.enabled) return 'pack';
  if (policy.limitBehavior === 'PAYG') return 'payg';
  return 'stop';
}

/**
 * 17c's body, measured: three answers as cards (the stored one marked),
 * "If the limit is reached", and "Alerts". Read state: every control is the
 * stored value, and nothing here writes — the auto-purchase write spends
 * money and is not wired from this screen.
 */
export async function AutoPurchase({
  policy,
  currency,
  paygRate = null,
}: {
  readonly policy: Policy | null;
  readonly currency: string;
  readonly paygRate?: string | null;
}) {
  const t = await getTranslations('billing');
  const format = await getFormatter();

  if (policy === null) {
    return (
      <p className={styles.unavailable} data-testid="auto-purchase-unset">
        {t('autoPurchase.unset')}
      </p>
    );
  }

  const used = capUsed(policy);
  const option = optionOf(policy);

  const card = (key: Option, children: ReactNode) => (
    <div
      className={styles.lowOption}
      data-current={option === key ? 'yes' : 'no'}
      data-testid={`auto-option-${key}`}
    >
      <span className={styles.lowRadio} aria-hidden="true" />
      <div className={styles.lowOptionBody}>
        <p className={styles.lowOptionName}>{t(`autoPurchase.option.${key}`)}</p>
        {children}
      </div>
    </div>
  );

  return (
    <div className={styles.lowDrawer} data-testid="auto-purchase">
      {card(
        'pack',
        <>
          <p className={styles.lowOptionText} data-testid="auto-state">
            {policy.enabled
              ? t('autoPurchase.on', { threshold: policy.thresholdPct })
              : t('autoPurchase.off')}
          </p>
          {/* The cap, with what has gone against it. */}
          <p className={styles.lowOptionText} data-testid="auto-cap">
            {policy.maxMonthlySpend === null
              ? t('autoPurchase.noCap')
              : t('autoPurchase.cap', {
                  cap: policy.maxMonthlySpend,
                  spent: policy.monthSpentAmount,
                  currency,
                  used: used === null ? '' : format.number(used, { style: 'percent' }),
                })}
          </p>
        </>,
      )}
      {card(
        'payg',
        <>
          {paygRate ? (
            <p className={styles.lowOptionText} data-testid="auto-payg-rate">
              {t('autoPurchase.paygRate', { rate: paygRate, currency })}
            </p>
          ) : null}
          {/*
            A behaviour the platform honours and the settings API refuses —
            shown, not hidden: the warning below is ABOUT pay-as-you-go.
          */}
          {!isSettable(policy.limitBehavior) ? (
            <p className={styles.lowOptionText} data-testid="auto-unsettable">
              {t('autoPurchase.unsettable')}
            </p>
          ) : null}
          {/* THE COMBINATION THAT LOOKS SAFE AND IS NOT. */}
          {policy.maxMonthlySpend !== null && spendsPastZero(policy.limitBehavior) ? (
            <p className={styles.autoContradiction} data-testid="auto-cap-not-a-cap">
              {t('autoPurchase.capIsNotACap')}
            </p>
          ) : null}
        </>,
      )}
      {card('stop', <p className={styles.lowOptionText}>{t('autoPurchase.stopText')}</p>)}

      <h3 className={styles.lowHeading}>{t('autoPurchase.ifReached')}</h3>
      {/* What happens when it runs out, described by tomorrow, not the enum. */}
      <p className={styles.lowOptionText} data-testid="auto-behavior">
        {t(`autoPurchase.behavior.${policy.limitBehavior}` as 'autoPurchase.behavior.STOP_AI')}
      </p>

      <h3 className={styles.lowHeading}>{t('autoPurchase.alerts')}</h3>
      {/*
        Both thresholds, because the gap is the point: somebody hears at 80%
        and the purchase happens at 10%. 02's other two alerts have no field.
      */}
      <ul className={styles.lowAlerts}>
        <li className={styles.lowAlert}>
          <span
            className={styles.lowPill}
            data-on={policy.enabled ? 'yes' : 'no'}
            aria-hidden="true"
          />
          <span data-testid={policy.enabled ? 'auto-warning' : undefined}>
            {policy.enabled
              ? t('autoPurchase.warnsFirst', { warn: policy.warningThresholdPct })
              : t('autoPurchase.warnAt', { warn: policy.warningThresholdPct })}
          </span>
        </li>
        <li className={styles.lowAlert} title={t('autoPurchase.alertNone')}>
          <span className={styles.lowNone}>—</span>
          <span>{t('autoPurchase.alertPurchase')}</span>
        </li>
        <li className={styles.lowAlert} title={t('autoPurchase.alertNone')}>
          <span className={styles.lowNone}>—</span>
          <span>{t('autoPurchase.alertLimit')}</span>
        </li>
      </ul>
    </div>
  );
}
