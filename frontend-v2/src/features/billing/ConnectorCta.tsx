'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { chooseShopifyPlan, type PlanSelection } from './connector-actions';
import styles from './Billing.module.css';

/**
 * "Choose Shopify plan": the server's plan-selection page for this store,
 * asked for at the press and opened as it came back. Nothing here builds a
 * Shopify address, and nothing here takes money: Shopify shows the price and
 * the charge on its own page.
 */
export function ChooseShopifyPlan({ testid = 'connector-cta' }: { readonly testid?: string }) {
  const t = useTranslations('billing.connector');
  const [refused, setRefused] = useState<Extract<PlanSelection, { ok: false }>['reason'] | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        className={styles.connectorCta}
        disabled={isPending}
        data-testid={testid}
        data-cta="choose"
        onClick={() => {
          setRefused(null);
          startTransition(async () => {
            const answer = await chooseShopifyPlan();
            if (answer.ok) window.location.assign(answer.url);
            else setRefused(answer.reason);
          });
        }}
      >
        {isPending ? t('opening') : t('cta.choose')}
      </button>
      {refused ? (
        <p className={styles.alertLine} role="alert" data-testid={`${testid}-refused`}>
          {t(`chooseRefused.${refused}`)}
        </p>
      ) : null}
    </>
  );
}
