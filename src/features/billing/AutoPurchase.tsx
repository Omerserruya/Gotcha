import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import type { PaymentMethod } from '@/api/contracts/billing-profile';
import { packagePrice, type PackagesResponse } from '@/api/contracts/pricing';

import {
  capUsed,
  isSettable,
  spendsPastZero,
  type AutoPurchase as Policy,
} from '@/api/contracts/auto-purchase';

import { AutoPurchaseForm, type PackChoice } from './AutoPurchaseForm';
import styles from './Billing.module.css';

/**
 * Screen 17c - when credits run low, and what happens when you stop.
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
 * zero is accrued and billed at the end of the cycle - **so the cap stops
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
 * stored value, and nothing here writes - the auto-purchase write spends
 * money and is not wired from this screen.
 */
export async function AutoPurchase({
  policy,
  currency,
  paygRate = null,
  packages = null,
  methods = null,
}: {
  readonly policy: Policy | null;
  readonly currency: string;
  readonly paygRate?: string | null;
  /** The packs on sale - what an automatic purchase would buy. */
  readonly packages?: PackagesResponse | null;
  /** The card it would charge; `null` when the read failed. */
  readonly methods?: readonly PaymentMethod[] | null;
}) {
  const t = await getTranslations('billing');
  const format = await getFormatter();
  const locale = await getLocale();
  const packs: PackChoice[] = (packages?.packages ?? []).map((p) => {
    const price = packagePrice(p);
    return {
      key: p.key,
      name: locale === 'he' && p.nameHe ? p.nameHe : p.name,
      price: price
        ? new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: price.currency,
            maximumFractionDigits: 2,
          }).format(price.amount)
        : null,
    };
  });
  const first = methods && methods.length > 0 ? methods[0]! : null;
  const card =
    methods === null
      ? ('unknown' as const)
      : first
        ? t('profile.card', {
            brand: first.brand ?? t('profile.unknownBrand'),
            last4: first.last4 ?? '????',
          })
        : null;
  // Off here: the environment's reason. On: the save is not wired yet - said so.
  const live = billingWritesEnabled();
  const heldTag = live ? t('held.tagNotBuilt') : t('held.tag');
  const heldWhy = live ? t('held.whyNotBuilt') : t('held.why');

  /*
    02 draws the three answers in every state. Nothing set is "Stop at my
    plan" marked - the platform's default when no policy row exists - with
    one line saying so; every figure a policy would carry is "-" rather than
    a schema default dressed up as a setting.
  */
  const used = policy ? capUsed(policy) : null;
  const option = policy ? optionOf(policy) : 'stop';

  return (
    <div className={styles.lowDrawer} data-testid="auto-purchase" data-set={policy ? 'yes' : 'no'}>
      {policy === null ? (
        <p
          className={styles.lowUnset}
          title={t('autoPurchase.unset')}
          data-testid="auto-purchase-unset"
        >
          {t('autoPurchase.unsetShort')}
        </p>
      ) : null}

      {/*
        02's three answers, editable (AutoPurchaseForm) and held at their
        confirm: turning automatic purchases on arms real charges, and dev's
        billing is the production payment account. What each holds now is
        still drawn here, into the form.
      */}
      <AutoPurchaseForm
        initialOption={option}
        initialThreshold={policy?.thresholdPct ?? 10}
        initialCap={policy?.maxMonthlySpend ?? null}
        initialBehavior={policy?.limitBehavior ?? 'STOP_AI'}
        packs={packs}
        currency={currency}
        card={card}
        heldTag={heldTag}
        heldWhy={heldWhy}
        current={{
          pack: (
            <>
              {policy ? (
                <p className={styles.lowOptionText} data-testid="auto-state">
                  {policy.enabled
                    ? t('autoPurchase.on', { threshold: policy.thresholdPct })
                    : t('autoPurchase.off')}
                </p>
              ) : null}
              {/* The cap, with what has gone against it - "-" when nothing is set. */}
              {policy ? (
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
              ) : (
                <p className={styles.lowOptionText} data-testid="auto-cap">
                  {t('autoPurchase.mostYouCould')} -
                </p>
              )}
            </>
          ),
          payg: (
            <>
              {paygRate ? (
                <p className={styles.lowOptionText} data-testid="auto-payg-rate">
                  {t('autoPurchase.paygRate', { rate: paygRate, currency })}
                </p>
              ) : null}
              {/*
            A behaviour the platform honours and the settings API refuses -
            shown, not hidden: the warning below is ABOUT pay-as-you-go.
          */}
              {policy && !isSettable(policy.limitBehavior) ? (
                <p className={styles.lowOptionText} data-testid="auto-unsettable">
                  {t('autoPurchase.unsettable')}
                </p>
              ) : null}
              {/* THE COMBINATION THAT LOOKS SAFE AND IS NOT. */}
              {policy && policy.maxMonthlySpend !== null && spendsPastZero(policy.limitBehavior) ? (
                <p className={styles.autoContradiction} data-testid="auto-cap-not-a-cap">
                  {t('autoPurchase.capIsNotACap')}
                </p>
              ) : null}
            </>
          ),
          stop: <span className={styles.lowOptionText}>{t('autoPurchase.stopText')}</span>,
        }}
      />

      <h3 className={styles.lowHeading}>{t('autoPurchase.alerts')}</h3>
      {/*
        Both thresholds, because the gap is the point: somebody hears at 80%
        and the purchase happens at 10%. 02's other two alerts have no field.
      */}
      <ul className={styles.lowAlerts}>
        {policy ? (
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
        ) : (
          <li className={styles.lowAlert} title={t('autoPurchase.alertNone')}>
            <span className={styles.lowNone}>-</span>
            <span>{t('autoPurchase.alertWarning')}</span>
          </li>
        )}
        <li className={styles.lowAlert} title={t('autoPurchase.alertNone')}>
          <span className={styles.lowNone}>-</span>
          <span>{t('autoPurchase.alertPurchase')}</span>
        </li>
        <li className={styles.lowAlert} title={t('autoPurchase.alertNone')}>
          <span className={styles.lowNone}>-</span>
          <span>{t('autoPurchase.alertLimit')}</span>
        </li>
      </ul>
    </div>
  );
}
