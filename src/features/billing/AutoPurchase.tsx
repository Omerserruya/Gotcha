import { getFormatter, getTranslations } from 'next-intl/server';

import {
  capUsed,
  isSettable,
  spendsPastZero,
  type AutoPurchase as Policy,
} from '@/api/contracts/auto-purchase';

import styles from './Billing.module.css';

/**
 * Screen 17d — topping up, and what happens when you stop.
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
export async function AutoPurchase({
  policy,
  currency,
}: {
  readonly policy: Policy | null;
  readonly currency: string;
}) {
  const t = await getTranslations('billing');
  const format = await getFormatter();

  if (policy === null) {
    // Nothing configured. Not a policy of defaults — the difference decides
    // whether "buys more at 10%" is a fact about this tenant or a guess.
    return (
      <p className={styles.unavailable} data-testid="auto-purchase-unset">
        {t('autoPurchase.unset')}
      </p>
    );
  }

  const used = capUsed(policy);

  return (
    <div className={styles.block} data-testid="auto-purchase">
      <p className={styles.autoState} data-testid="auto-state">
        {policy.enabled
          ? t('autoPurchase.on', { threshold: policy.thresholdPct })
          : t('autoPurchase.off')}
      </p>

      {/*
        Both thresholds, because the gap between them is the point: somebody
        hears about it at 80% and the purchase happens at 10%.
      */}
      {policy.enabled ? (
        <p className={styles.autoWarning} data-testid="auto-warning">
          {t('autoPurchase.warnsFirst', { warn: policy.warningThresholdPct })}
        </p>
      ) : null}

      {/* The cap, with what has gone against it. */}
      <p className={styles.autoCap} data-testid="auto-cap">
        {policy.maxMonthlySpend === null
          ? t('autoPurchase.noCap')
          : t('autoPurchase.cap', {
              cap: policy.maxMonthlySpend,
              spent: policy.monthSpentAmount,
              currency,
              used: used === null ? '' : format.number(used, { style: 'percent' }),
            })}
      </p>

      {/*
        What happens when it runs out, described by tomorrow rather than by
        the enum's name.
      */}
      <p className={styles.autoBehavior} data-testid="auto-behavior">
        {t(`autoPurchase.behavior.${policy.limitBehavior}` as 'autoPurchase.behavior.STOP_AI')}
      </p>

      {/*
        A behaviour the platform honours and the settings API refuses. Shown
        as unavailable rather than hidden: the cap warning below is ABOUT
        pay-as-you-go, and a warning about an option nobody can see is a
        puzzle.
      */}
      {!isSettable(policy.limitBehavior) ? (
        <p className={styles.autoUnsettable} data-testid="auto-unsettable">
          {t('autoPurchase.unsettable')}
        </p>
      ) : null}

      {/*
        THE COMBINATION THAT LOOKS SAFE AND IS NOT. A cap with pay-as-you-go
        stops the auto-purchase, not the bill.
      */}
      {policy.maxMonthlySpend !== null && spendsPastZero(policy.limitBehavior) ? (
        <p className={styles.autoContradiction} data-testid="auto-cap-not-a-cap">
          {t('autoPurchase.capIsNotACap')}
        </p>
      ) : null}
    </div>
  );
}
