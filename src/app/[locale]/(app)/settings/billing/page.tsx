import { buyCreditPack } from '@/features/billing/actions';
import { billingWritesEnabled } from '@/api/client/billing-writes';
import { PROFILE_FORM_ID } from '@/features/billing/profile-form';
import { getTranslations } from 'next-intl/server';

import styles from '@/features/billing/Billing.module.css';
import { AutoPurchase } from '@/features/billing/AutoPurchase';
import { hasSomethingToCharge, profileReading } from '@/api/contracts/billing-profile';
import { BillingProfileSection } from '@/features/billing/BillingProfile';
import { BuyCredits } from '@/features/billing/BuyCredits';
import { CreditsSection } from '@/features/billing/Credits';
import { BillingOverlay } from '@/features/billing/BillingOverlay';
import { loadBilling } from '@/features/billing/load-billing';
import { CreditPackagesSection } from '@/features/billing/Pricing';
import {
  BillingCard,
  BuyUnavailable,
  CreditsWent,
  CycleValue,
  PlanHero,
  RunningLow,
} from '@/features/billing/Overview';
import { Link } from '@/i18n/navigation';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Usage & billing - screen 17.
 *
 * *"Your plan up front, credits in conversations."* 02's layout: the plan,
 * dark, across the top; then credits left and where they went on the left,
 * and running low, billing and the cycle's value on the right.
 *
 * Buying credits (17d), the running-low rule (17c) and the billing details
 * (17e) open over it from their buttons (`?panel=`); every invoice is its own
 * page (`./invoices`), behind the Billing card's All.
 *
 * Not drawn, because nothing reads them: 02's "3 AI employees · All
 * channels", the run-out projection ("Lasts until renewal" is "-"), credits
 * per kind of work, and the value line (hours saved, outreach revenue).
 *
 * The conversations allowance ("Conversations this period") is not on 02's
 * screen and is gone from it: on this tenant it said only that the plan does
 * not cap conversations.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly panel?: string }>;
}) {
  const t = await getTranslations('billing');
  const panel = (await searchParams)?.panel;
  const {
    subscription,
    plans,
    invoices,
    breakdown,
    autoPurchase,
    profile,
    paymentMethods,
    credits,
    packages,
  } = await loadBilling();

  return (
    <SettingsSection title={t('title')} description={t('description')} fill>
      <PlanHero subscription={subscription} plans={plans} credits={credits} />

      <div className={styles.overview}>
        <div className={styles.overviewMain}>
          <CreditsSection credits={credits} />
          <CreditsWent breakdown={breakdown} />
        </div>
        <div className={styles.overviewSide}>
          <RunningLow
            policy={autoPurchase?.policy ?? null}
            currency={autoPurchase?.currency ?? 'ILS'}
          />
          <BillingCard profile={profile} methods={paymentMethods} invoices={invoices} />
          <CycleValue />
        </div>
      </div>

      {panel === 'buy' ? (
        <BillingOverlay kind="dialog" title={t('overview.overlay.buy')} line={t('buy.subline')}>
          <BuyCredits
            packages={packages}
            /*
              `buyCredits()` checks `no_billable_entity` FIRST, so these are
              the server's own two gates read back in the same order - two
              booleans, because "nobody to invoice" and "nothing to charge"
              have different repairs.
            */
            billable={profileReading(profile) !== 'no_account'}
            hasPaymentMethod={paymentMethods !== null && hasSomethingToCharge(paymentMethods)}
            card={paymentMethods?.[0] ?? null}
            receiptTo={profile?.billingEmail ?? null}
            /*
              The purchase is handed to the dialog only where billing may move
              money (BILLING_WRITES=on, fail closed). Dev's billing is the live
              payment account: there the pay button is the held status.
            */
            charge={billingWritesEnabled() ? buyCreditPack : null}
          />
          {/*
            Nothing to buy says why - the plan cannot, the shelf is empty, or
            we could not find out - rather than leaving the dialog blank.
          */}
          {packages === null ? (
            <BuyUnavailable methods={paymentMethods} />
          ) : packages.packages.length === 0 ? (
            <CreditPackagesSection packages={packages} />
          ) : null}
        </BillingOverlay>
      ) : panel === 'low' ? (
        <BillingOverlay
          kind="drawer"
          title={t('overview.overlay.low')}
          line={t('autoPurchase.subline')}
          footer={
            <>
              <span
                className={styles.overlayFootPrimary}
                aria-disabled="true"
                title={t('profile.notYet')}
                data-testid="low-save"
              >
                {t('autoPurchase.save')}
              </span>
              <Link href="/settings/billing" className={styles.overlayFootCancel}>
                {t('autoPurchase.cancel')}
              </Link>
            </>
          }
        >
          <AutoPurchase
            policy={autoPurchase?.policy ?? null}
            currency={autoPurchase?.currency ?? 'ILS'}
            paygRate={autoPurchase?.paygRate ?? null}
          />
        </BillingOverlay>
      ) : panel === 'details' ? (
        <BillingOverlay
          kind="drawer"
          title={t('overview.overlay.details')}
          line={t('profile.subline')}
          footer={
            <>
              {/*
                17e's Save (database only): it submits the details form. With
                no billing record yet there is nothing to save into - said.
              */}
              {profile?.state === 'present' ? (
                <button
                  type="submit"
                  form={PROFILE_FORM_ID}
                  className={styles.overlayFootPrimary}
                  data-live=""
                  data-testid="details-save"
                >
                  {t('profile.save')}
                </button>
              ) : (
                <span
                  className={styles.overlayFootPrimary}
                  aria-disabled="true"
                  title={t('profile.saveRefused.no_record')}
                  data-testid="details-save"
                >
                  {t('profile.save')}
                </span>
              )}
              <Link href="/settings/billing" className={styles.overlayFootCancel}>
                {t('profile.cancel')}
              </Link>
              <span className={styles.overlayFootNote}>{t('profile.heldBy')}</span>
            </>
          }
        >
          <BillingProfileSection
            profile={profile}
            methods={paymentMethods}
            /*
              `null` when the invoices read failed, NOT zero - defaulting to an
              empty array is what once silently removed "and 4 charges have
              already failed" from the warning.
            */
            failedInvoiceCount={
              invoices === null ? null : invoices.filter((i) => i.status === 'FAILED').length
            }
          />
        </BillingOverlay>
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.billing');
