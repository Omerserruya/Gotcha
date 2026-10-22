import { getLocale, getTranslations } from 'next-intl/server';

import { planNameFor, type Plan, type Subscription } from '@/api/contracts/billing';
import {
  isStillPending,
  noneOnSale,
  planCannotBuyPackages,
  priceIsConverted,
  rateIsFallback,
  type CurrencyBlock,
  type PackagesResponse,
} from '@/api/contracts/pricing';

import styles from './Billing.module.css';

/**
 * Screen 17b - the plan, what it costs, and what is already scheduled.
 *
 * Three things this section refuses to simplify, each for a measured reason:
 *
 * 1. **The price is NET.** Every catalogue price excludes tax, and the routes
 *    are insistent that the tax travels with it or *"the page shows a total
 *    nobody can check against the one on their statement"*.
 * 2. **The displayed currency may not be the charged one.** `chargedCurrency`
 *    and `isEstimatedConversion` exist precisely so a UI does not assume.
 * 3. **A scheduled change is typed.** `CANCEL` is not a plan change, and the
 *    sentence for it says the subscription ends.
 */
export async function CurrentPlanSection({
  subscription,
  plans,
  currency,
  tax,
  disclaimer,
}: {
  readonly subscription: Subscription | null;
  readonly plans: readonly Plan[];
  readonly currency: CurrencyBlock | null;
  readonly tax: { ratePct: number | null; label: string | null } | null;
  readonly disclaimer: { en: string; he: string } | null;
}) {
  const t = await getTranslations('billing.pricing');
  const locale = await getLocale();

  if (!subscription) {
    return (
      <p className={styles.unavailable} data-testid="pricing-unavailable">
        {t('unavailable')}
      </p>
    );
  }

  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const pending = subscription.pendingChange;
  const showPending = isStillPending(pending);

  return (
    <div className={styles.pricing} data-testid="pricing-current">
      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ THE SIBLING OF THE `BuyCredits` TAX DEFECT, ON THE SAME SCREEN
        ════════════════════════════════════════════════════════════════════
        This read *"Prices are before מע\"מ."* in English, and it was the same
        `label` from the same platform, localised to the ACCOUNT and not to the
        reader - the defect Wave 1 reasoned about at length and fixed in one of
        its two renderers. It was also OUTSIDE an isolate, so the Hebrew
        reordered the English sentence around it: two defects on one line.

        Our own word leads, so there is nothing left in an unknown language to
        isolate and the second defect goes with the first.

        ── AND THE TRIGGER CHANGED, WHICH IS THE PART TO READ ──
        The guard was `tax?.label` - the platform's string doubled as the
        signal that tax applies. Dropping the string would have dropped the
        whole sentence for a tenant whose rate we know and whose label we do
        not. So the guard is now "the platform said SOMETHING about tax", and
        the rate is preferred because it is the part a person can check.
        Neither field present means we were told nothing, and we say nothing.
      */}
      {tax && (tax.ratePct != null || tax.label != null) ? (
        <p className={styles.pricingNote} data-testid="pricing-net">
          {tax.ratePct != null ? t('netOfTaxRate', { rate: tax.ratePct }) : t('netOfTax')}
        </p>
      ) : null}

      {currency && priceIsConverted(currency) ? (
        <p className={styles.pricingNote} data-testid="pricing-currency">
          {/*
            A fallback rate is not a rate. When the conversion rests on one,
            the sentence says so AND names the charged amount as the one that
            will match the statement - because that is the number a person can
            actually check.
          */}
          {rateIsFallback(currency)
            ? t('convertedFallback', {
                display: currency.display,
                charged: currency.chargedCurrency,
              })
            : t('converted', {
                display: currency.display,
                charged: currency.chargedCurrency,
              })}
        </p>
      ) : null}

      {showPending && pending ? (
        <div className={styles.pendingChange} data-testid="pricing-pending">
          <p className={styles.pendingLine} data-testid="pricing-pending-line">
            {/*
              Typed. `CANCEL` says the subscription ends; rendering it as a
              plan change would produce "changes to -" for a customer who is
              leaving, on the screen about their money.

              And the date carries the YEAR: every change available here lands
              in September 2027, and a bare "8 September" reads as this year.
            */}
            {pending.changeType === 'CANCEL' || pending.changeType === 'VOLUME_CHANGE'
              ? t(`pending.${pending.changeType}`, {
                  date: pending.effectiveAt ? day.format(new Date(pending.effectiveAt)) : '-',
                })
              : t(`pending.${pending.changeType}`, {
                  plan: pending.targetPlanKey
                    ? (planNameFor(plans, pending.targetPlanKey, locale) ?? pending.targetPlanKey)
                    : '-',
                  date: pending.effectiveAt ? day.format(new Date(pending.effectiveAt)) : '-',
                })}
          </p>
          <p className={styles.pendingReassurance} data-testid="pricing-pending-holds">
            {/* The service's own sentence, and it is the one people want. */}
            {t('pending.nothingChangesYet')}
          </p>
        </div>
      ) : null}

      {disclaimer ? (
        <p className={styles.pricingDisclaimer} data-testid="pricing-disclaimer">
          {/*
            The PLATFORM's sentence, per locale - the same one the public
            pricing pages render. A second translation of a commercial claim
            could drift from it with nothing failing.
          */}
          {locale === 'he' ? disclaimer.he : disclaimer.en}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Credit packages, and the two very different reasons there might be none.
 *
 * `{ packages: [], eligible: false }` is a plan that cannot buy them at all.
 * `eligible: true` with an empty list is a plan that can, with nothing on
 * sale. One is about their plan and one is not, and a single "no packages
 * available" would tell the second group to go and upgrade for no reason.
 *
 * `null` is neither: it means the read failed, which must never be rendered
 * as a fact about their plan.
 */
export async function CreditPackagesSection({
  packages,
}: {
  readonly packages: PackagesResponse | null;
}) {
  const t = await getTranslations('billing.pricing');
  const locale = await getLocale();

  if (!packages) {
    return (
      <p className={styles.unavailable} data-testid="packages-unavailable">
        {t('packages.unavailable')}
      </p>
    );
  }

  if (planCannotBuyPackages(packages)) {
    return (
      <p className={styles.pricingNote} data-testid="packages-ineligible">
        {t('packages.ineligible')}
      </p>
    );
  }

  if (noneOnSale(packages)) {
    return (
      <p className={styles.pricingNote} data-testid="packages-none">
        {t('packages.none')}
      </p>
    );
  }

  const number = new Intl.NumberFormat(locale);

  return (
    <ul className={styles.packages} data-testid="packages">
      {packages.packages.map((pkg) => (
        <li key={pkg.key} className={styles.package} data-testid="package">
          <span className={styles.packageName}>
            {locale === 'he' && pkg.nameHe ? pkg.nameHe : pkg.name}
          </span>
          <span className={styles.packageCredits}>
            {t('packages.credits', { credits: number.format(pkg.credits) })}
          </span>
          {/*
            The ONLY place a customer ever learns when bought credits die.
            `/billing/credit-summary` selects `expiresAt` from the lots and
            uses only `grantType`, so per-lot expiry never reaches the wire -
            after the purchase, nothing can tell them. Before it, this can.
          */}
          <span className={styles.packageExpiry} data-testid="package-expiry">
            {pkg.expiryPolicy === 'DAYS_AFTER_PURCHASE'
              ? t('packages.expiry.DAYS_AFTER_PURCHASE', { days: pkg.expiryDays ?? 0 })
              : t(`packages.expiry.${pkg.expiryPolicy}`)}
          </span>
        </li>
      ))}
    </ul>
  );
}
