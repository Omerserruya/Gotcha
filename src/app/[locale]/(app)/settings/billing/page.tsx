import { getTranslations } from 'next-intl/server';

import styles from '@/features/billing/Billing.module.css';
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
 * and the spending cap. The last two have no field anywhere — writing them
 * would be asserting billing behaviour from a mockup, which on this screen is
 * the worst place to guess.
 */
export default async function Page() {
  const t = await getTranslations('billing');
  const { allowance, subscription, plans, invoices, breakdown } = await loadBilling();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <PlanLine subscription={subscription} plans={plans} />

      <section className={styles.section} data-testid="section-runway">
        <h2 className={styles.sectionHeading}>{t('heading.runway')}</h2>
        <Runway allowance={allowance} />
      </section>

      <section className={styles.section} data-testid="section-breakdown">
        <h2 className={styles.sectionHeading}>{t('heading.breakdown')}</h2>
        <UsageBreakdownSection breakdown={breakdown} />
      </section>

      <section className={styles.section} data-testid="section-invoices">
        <h2 className={styles.sectionHeading}>{t('heading.invoices')}</h2>
        <Invoices invoices={invoices} />
      </section>
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.billing');
