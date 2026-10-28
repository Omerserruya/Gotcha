import { getTranslations } from 'next-intl/server';

import type { ConnectorVerdict } from '@/api/contracts/shopify-connector';
import { Link } from '@/i18n/navigation';

import { ChooseShopifyPlan } from './ConnectorCta';
import styles from './Billing.module.css';

/**
 * The Billing page's second section: the Shopify Connector. A separate
 * subscription from GOTCHA Core, billed and managed ONLY by Shopify - so it
 * carries no price, no card and no GOTCHA payment step, and its one button
 * leads to Shopify's own page, at the address the server gave.
 *
 * Shopify review 132211 rejected a Billing page whose plans could not be told
 * apart by who bills them. This section is its own card, under its own name,
 * with "Billed and managed by Shopify" on it, and never sits among Core's
 * cards.
 *
 * Everything drawn is `connectorVerdict()`: the integration screen draws the
 * same verdict, so the two cannot disagree.
 */
export async function ConnectorSection({ verdict }: { readonly verdict: ConnectorVerdict }) {
  const t = await getTranslations('billing.connector');
  return (
    <section
      className={styles.connectorCard}
      data-testid="connector-section"
      data-kind={verdict.kind}
      aria-labelledby="connector-title"
    >
      <header className={styles.cardHead}>
        <h2 className={styles.cardTitle} id="connector-title">
          {t('title')}
        </h2>
        <span className={styles.connectorTag} data-testid="connector-billed-by">
          {t('billedBy')}
        </span>
      </header>
      <p className={styles.connectorWhat} data-testid="connector-what">
        {t('what')}
      </p>
      {/* Awaited, not nested: an async child is not rendered by every renderer this runs in. */}
      {await ConnectorFacts({ verdict })}
      <div className={styles.connectorFoot}>{await ConnectorActions({ verdict })}</div>
    </section>
  );
}

/** Status, Shopify access and the store - the rows both screens show. */
export async function ConnectorFacts({ verdict }: { readonly verdict: ConnectorVerdict }) {
  const t = await getTranslations('billing.connector');
  return (
    <dl className={styles.billingRows}>
      <div className={styles.billingRow} data-testid="connector-row-status">
        <dt>{t('statusLabel')}</dt>
        <dd
          data-testid="connector-status"
          title={verdict.kind === 'unread' ? t('unreadTitle') : undefined}
        >
          <span className={styles.connectorStatus} data-kind={verdict.kind}>
            {t(`kind.${verdict.kind}`)}
          </span>
          <span className={styles.connectorDetail} data-testid="connector-detail">
            {t(`detail.${verdict.kind}`)}
          </span>
        </dd>
      </div>
      <div className={styles.billingRow} data-testid="connector-row-access">
        <dt>{t('accessLabel')}</dt>
        {/* The server's grantsAccess, verbatim. A failed read claims nothing. */}
        <dd
          data-testid="connector-access"
          data-access={verdict.grantsAccess === null ? 'unread' : String(verdict.grantsAccess)}
        >
          {verdict.grantsAccess === null
            ? '-'
            : verdict.grantsAccess
              ? t('access.on')
              : t('access.off')}
        </dd>
      </div>
      {verdict.shopDomain ? (
        <div className={styles.billingRow} data-testid="connector-row-store">
          <dt>{t('storeLabel')}</dt>
          <dd>
            <bdi dir="ltr">{verdict.shopDomain}</bdi>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The verdict's one action. `choose` asks the server for Shopify's page;
 * `manage` is the server's `manageUrl` as sent; `connect` is the integration
 * screen - and waits for GOTCHA Core when the server says it must.
 */
export async function ConnectorActions({
  verdict,
  testid = 'connector-cta',
}: {
  readonly verdict: ConnectorVerdict;
  readonly testid?: string;
}) {
  const t = await getTranslations('billing.connector');
  switch (verdict.cta) {
    case 'choose':
      return <ChooseShopifyPlan testid={testid} />;
    case 'manage':
      return verdict.url ? (
        <a
          href={verdict.url}
          className={styles.connectorCta}
          data-testid={testid}
          data-cta="manage"
        >
          {t('cta.manage')}
        </a>
      ) : (
        <p className={styles.connectorDetail} data-testid={`${testid}-in-shopify`}>
          {t('manageInShopify')}
        </p>
      );
    case 'connect':
      return verdict.connectAllowed === false ? (
        <p className={styles.connectorDetail} data-testid={`${testid}-core-first`}>
          {t('coreFirst')}{' '}
          <Link href="/settings/billing/plan" className={styles.underlineLink}>
            {t('coreFirstLink')}
          </Link>
        </p>
      ) : (
        <Link
          href={{ pathname: '/studio/capabilities', query: { system: 'shopify' } }}
          className={styles.connectorCta}
          data-testid={testid}
          data-cta="connect"
        >
          {t('cta.connect')}
        </Link>
      );
    default:
      return null;
  }
}
