import { getTranslations } from 'next-intl/server';

import styles from '@/features/billing/Billing.module.css';
import { AutoPurchase } from '@/features/billing/AutoPurchase';
import { BillingProfileSection } from '@/features/billing/BillingProfile';
import { CreditsSection } from '@/features/billing/Credits';
import { Invoices, PlanLine, UsageBreakdownSection } from '@/features/billing/BillingSections';
import { loadBilling } from '@/features/billing/load-billing';
import { Runway } from '@/features/billing/Runway';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Usage & billing — screen 17.
 *
 * *"Usage as runway, not credits. The user should know how long they are good
 * for, not do arithmetic."*
 *
 * Runway first, because that is the question someone opened this screen with.
 * Then the plan, where the period went, and the invoices.
 *
 * Three things the design draws are absent, and none is softened: the value
 * line (nothing computes hours saved or revenue attributed), the overage rate,
 * and the overage RATE, which has no field.
 *
 * **The spending cap is no longer among them.** `AutoPurchasePolicy` carries
 * `maxMonthlySpend`, two thresholds and five limit behaviours, and it is
 * configured on this tenant — 500.00 with 110.00 already spent. That
 * sentence used to say the cap had no field anywhere; it was written before
 * anyone read that model.
 */
export default async function Page() {
  const t = await getTranslations('billing');
  const {
    allowance,
    subscription,
    plans,
    invoices,
    breakdown,
    autoPurchase,
    profile,
    paymentMethods,
    credits,
  } = await loadBilling();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <PlanLine subscription={subscription} plans={plans} />

      <section className={styles.section} data-testid="section-runway">
        <h2 className={styles.sectionHeading}>{t('heading.runway')}</h2>
        <Runway allowance={allowance} />
      </section>

      <section className={styles.section} data-testid="section-credits">
        <h2 className={styles.sectionHeading}>{t('heading.credits')}</h2>
        <CreditsSection credits={credits} />
      </section>

      <section className={styles.section} data-testid="section-breakdown">
        <h2 className={styles.sectionHeading}>{t('heading.breakdown')}</h2>
        <UsageBreakdownSection breakdown={breakdown} />
      </section>

      <section className={styles.section} data-testid="section-auto-purchase">
        <h2 className={styles.sectionHeading}>{t('heading.autoPurchase')}</h2>
        <AutoPurchase
          policy={autoPurchase?.policy ?? null}
          currency={autoPurchase?.currency ?? 'ILS'}
        />
      </section>

      <section className={styles.section} data-testid="section-profile">
        <h2 className={styles.sectionHeading}>{t('heading.profile')}</h2>
        <BillingProfileSection
          profile={profile}
          methods={paymentMethods}
          /*
            `null` when the invoices read failed, NOT zero. Defaulting to an
            empty array here is what let a lost fetch silently remove "and 4
            charges have already failed" from the warning below it.
          */
          failedInvoiceCount={
            invoices === null ? null : invoices.filter((i) => i.status === 'FAILED').length
          }
        />
      </section>

      <section className={styles.section} data-testid="section-invoices">
        <h2 className={styles.sectionHeading}>{t('heading.invoices')}</h2>
        <Invoices invoices={invoices} />
      </section>
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.billing');
