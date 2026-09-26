import { getTranslations } from 'next-intl/server';

import { plansResponseSchema } from '@/api/contracts/billing';
import { billingEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import styles from '@/features/billing/Billing.module.css';
import { ChangePlanGate } from '@/features/billing/ChangePlanGate';
import { loadPricing } from '@/features/billing/load-pricing';
import { CreditPackagesSection, CurrentPlanSection } from '@/features/billing/Pricing';
import { PlanLine } from '@/features/billing/BillingSections';
import { logger } from '@/observability/logger';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Plan & pricing — screen 17b.
 *
 * Separate from Usage & billing because it answers a different question.
 * That screen says how long you are good for; this one says what you are on
 * and what changing it would do.
 *
 * **Every change available to this tenant is a downgrade**, and downgrades are
 * deferred to the end of the period — 8 September 2027, on an annual
 * subscription. So the screen leads with the date rather than with a control,
 * and states the service's own guarantee that nothing moves until then.
 */
export default async function Page() {
  const t = await getTranslations('billing.pricing');
  const { subscription, currency, tax, disclaimer, packages, paymentMethods } = await loadPricing();

  const plans = await serverApi()
    .get({ endpoint: billingEndpoints.plans(), payload: plansResponseSchema, raw: true })
    .then((r) => r.plans)
    .catch((cause: unknown) => {
      // Costs the plan its NAME, not the screen — the key is ugly and true.
      logger.warn('pricing.plans_failed', { cause });
      return [];
    });

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <section className={styles.section} data-testid="section-plan">
        <h2 className={styles.sectionHeading}>{t('heading.current')}</h2>
        <PlanLine subscription={subscription} plans={plans} />
        <CurrentPlanSection
          subscription={subscription}
          plans={plans}
          currency={currency}
          tax={tax}
          disclaimer={disclaimer}
        />
      </section>

      <section className={styles.section} data-testid="section-change">
        <h2 className={styles.sectionHeading}>{t('heading.change')}</h2>
        <ChangePlanGate
          /*
           * The date a change WOULD take effect is the period end — the same
           * value `changePlan` writes as `effectiveAt`. When one is already
           * scheduled its own date is shown above; this is the date a NEW one
           * would land on.
           */
          effectiveAt={subscription?.currentPeriodEnd ?? null}
          /*
           * Null means the read failed, not that there is no card. Treating
           * an unknown as "no payment method" would tell somebody with a
           * valid card that their upgrade will be declined.
           */
          hasPaymentMethod={paymentMethods === null || paymentMethods.length > 0}
        />
      </section>

      <section className={styles.section} data-testid="section-packages">
        <h2 className={styles.sectionHeading}>{t('heading.packages')}</h2>
        <CreditPackagesSection packages={packages} />
      </section>
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.billingPlan');
