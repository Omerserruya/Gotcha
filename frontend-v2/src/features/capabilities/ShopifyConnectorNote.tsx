import { getTranslations } from 'next-intl/server';

import type { ConnectorVerdict } from '@/api/contracts/shopify-connector';
import { ConnectorActions } from '@/features/billing/ConnectorSection';

import styles from './Capabilities.module.css';

/**
 * Under Shopify's head: what the Connector's state means, and its one action
 * (choose or manage the plan in Shopify) - the same words and the same button
 * as the Billing page's Connector section, from the same verdict. The
 * uninstall wait has its own line in the head; a failed read claims nothing.
 */
export async function ShopifyConnectorNote({ verdict }: { readonly verdict: ConnectorVerdict }) {
  if (verdict.kind === 'unread' || verdict.kind === 'uninstall_pending') return null;
  const t = await getTranslations('billing.connector');
  return (
    <div className={styles.connectorNote} data-testid="system-connector" data-kind={verdict.kind}>
      <p className={styles.connectLead} data-testid="system-connector-detail">
        {t(`detail.${verdict.kind}`)}
      </p>
      {await ConnectorActions({ verdict, testid: 'system-connector-cta' })}
    </div>
  );
}
