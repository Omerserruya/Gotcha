import { getTranslations } from 'next-intl/server';

import { plansResponseSchema } from '@/api/contracts/billing';
import { billingEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import styles from '@/features/billing/Billing.module.css';
import { ChangePlanGate } from '@/features/billing/ChangePlanGate';
import { loadPricing } from '@/features/billing/load-pricing';
import { PlanCards, SwitchActions, SwitchSummary } from '@/features/billing/PlanChoice';
import { CurrentPlanSection } from '@/features/billing/Pricing';
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
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly plan?: string }>;
}) {
  const t = await getTranslations('billing.pricing');
  const nav = await getTranslations('navigation');
  const picked = (await searchParams)?.plan ?? null;
  const { subscription, currency, tax, disclaimer, paymentMethods, catalog } = await loadPricing();

  const plans = await serverApi()
    .get({ endpoint: billingEndpoints.plans(), payload: plansResponseSchema, raw: true })
    .then((r) => r.plans)
    .catch((cause: unknown) => {
      // Costs the plan its NAME, not the screen — the key is ugly and true.
      logger.warn('pricing.plans_failed', { cause });
      return [];
    });

  const currentKey = subscription?.planKey ?? null;
  const current = catalog.find((p) => p.key === currentKey) ?? null;
  // Only a plan on offer, and not the one you are on, can be picked.
  const target =
    picked && picked !== currentKey ? (catalog.find((p) => p.key === picked) ?? null) : null;

  /*
    17b, measured: the plans side by side, then what switching would do
    beside the button that does it. The notes that used to be the screen —
    the deferred date, "replaceable, never clearable", tax, currency, a
    scheduled change — are its fine print now, under the button.
  */
  return (
    <SettingsSection
      title={t('title')}
      // 17b: a sub-page of Usage & billing, "← Usage & billing" above the title.
      back={{ href: '/settings/billing', label: nav('settings.billing') }}
    >
      <PlanCards catalog={catalog} currentKey={currentKey} selectedKey={target?.key ?? null} />

      <div className={styles.switchRow}>
        <SwitchSummary target={target} current={current} subscription={subscription} />
        <div className={styles.switchSide}>
          <SwitchActions target={target} current={current} methods={paymentMethods} />
          <div className={styles.switchNotes}>
            <CurrentPlanSection
              subscription={subscription}
              plans={plans}
              currency={currency}
              tax={tax}
              disclaimer={disclaimer}
            />
            <ChangePlanGate
              /*
               * The date a change WOULD take effect is the period end — the
               * same value `changePlan` writes as `effectiveAt`.
               */
              effectiveAt={subscription?.currentPeriodEnd ?? null}
              /*
               * Null means the read failed, not that there is no card.
               */
              hasPaymentMethod={paymentMethods === null || paymentMethods.length > 0}
            />
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.billingPlan');
