import { getTranslations } from 'next-intl/server';

import { sentenceCase, type Integration } from '@/api/contracts/integrations';
import { platformErrorReason } from '@/api/contracts/platform-errors';
import type { ConnectorVerdict } from '@/api/contracts/shopify-connector';

import { ConnectFor } from './ConnectFor';
import { IntegrationLogo } from './IntegrationLogo';
import { systemCategoryName } from './system-category';
import styles from './Capabilities.module.css';

const RISK = new Set(['LOW', 'MEDIUM', 'HIGH']);

/**
 * 10 for a system that is not connected (Omer, 2026-10-04): its own screen -
 * the mark, the name, what it is, what it would bring, and Connect.
 *
 * How it connects is the catalogue's to say:
 *   · fields  - a credentials form, live.
 *   · OAuth   - at the provider. Live where the way back comes here
 *               (backend 381a5d1b: HubSpot, Salesforce, Monday); drawn, with
 *               why, where it still leads to the previous app.
 *   · neither - `custom_api`: set up with GOTCHA, not by a form; drawn.
 */
export async function AvailableSystem({
  integration,
  shopify = null,
  connector = null,
}: {
  readonly integration: Integration;
  /** Shopify's install availability, read before the button (98676242), and whether Core allows it. */
  readonly shopify?: {
    readonly mode: string;
    readonly helpUrl: string | null;
    readonly connectAllowed?: boolean | null;
  } | null;
  /**
   * Shopify only: the Connector verdict, the Billing page's. It wins over the
   * legacy integration row - a workspace whose store was installed and later
   * removed keeps an old DISCONNECTED row with its last error, and that row
   * read "Disconnected" and "Something went wrong" beside a Billing page that
   * says "No store connected" (dev, 2026-10-28; review 132211).
   */
  readonly connector?: ConnectorVerdict | null;
}) {
  const t = await getTranslations('capabilities');
  const tp = await getTranslations('common.platformError');
  const tc = await getTranslations('billing.connector');
  const verdict = integration.slug === 'shopify' && connector?.kind !== 'unread' ? connector : null;
  // A row left DISCONNECTED (a disconnect, or Shopify's uninstall) says so, and why - in words.
  const left = integration.tenantConnection?.status === 'DISCONNECTED';
  const reason =
    left && !verdict
      ? platformErrorReason(
          integration.tenantConnection?.lastError,
          integration.tenantConnection?.lastErrorCode,
        )
      : null;
  const line = [
    integration.category ? systemCategoryName(integration.category, t) : null,
    integration.description,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={styles.available} data-testid={`available-system-${integration.slug}`}>
      <header className={styles.systemHead} data-testid="system-head">
        <IntegrationLogo slug={integration.slug} size="head" />
        <span className={styles.systemTitle}>
          <span className={styles.systemName}>{integration.name}</span>
          {line ? (
            <span className={styles.systemLine} data-testid="system-line">
              {line}
            </span>
          ) : null}
          {reason ? (
            <span className={styles.systemError} role="note" data-testid="system-error">
              {reason === 'unknown'
                ? t('reconnect.unknown', { name: integration.name })
                : tp(reason)}
            </span>
          ) : null}
        </span>
        <span className={styles.systemActions}>
          {verdict ? (
            <span
              className={styles.systemState}
              data-state={verdict.kind}
              data-testid="system-state"
            >
              {tc(`kind.${verdict.kind}`)}
            </span>
          ) : (
            <span
              className={styles.systemState}
              data-state="DISCONNECTED"
              data-testid="system-state"
            >
              {left ? t('rail.state.DISCONNECTED') : t('available.notConnected')}
            </span>
          )}
        </span>
      </header>

      <section className={styles.connectCard} data-testid="connect-card">
        <h2 className={styles.connectHeading}>
          {t('available.connectTitle', { name: integration.name })}
        </h2>
        <ConnectFor
          integration={integration}
          shopify={shopify}
          drawn={{
            connect: t('available.connect'),
            oauthNotHere: t('available.oauthNotHere', { name: integration.name }),
            noForm: t('available.noForm'),
          }}
        />
      </section>

      <section className={styles.group} data-testid="available-brings">
        <h2 className={styles.groupHeading}>{t('available.brings')}</h2>
        {integration.catalogTools.length === 0 ? (
          <p className={styles.bringsNone} title={t('available.bringsNone')}>
            -
          </p>
        ) : (
          <ul className={styles.capabilities}>
            {integration.catalogTools.map((tool) => (
              <li key={tool.id} className={styles.capability} data-testid={`brings-${tool.slug}`}>
                <span className={styles.what}>
                  {sentenceCase(tool.name, integration.name)}
                  {tool.riskLevel && RISK.has(tool.riskLevel) ? (
                    <span className={styles.risk} data-risk={tool.riskLevel}>
                      {t(`risk.${tool.riskLevel}` as 'risk.LOW')}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
