import { getTranslations } from 'next-intl/server';

import { humaniseCode } from '@/api/contracts/capabilities';
import { sentenceCase, type Integration } from '@/api/contracts/integrations';

import { ConnectForm } from './ConnectForm';
import { IntegrationLogo } from './IntegrationLogo';
import { OAuthButton } from './OAuthButton';
import { oauthHere } from './oauth';
import styles from './Capabilities.module.css';

const RISK = new Set(['LOW', 'MEDIUM', 'HIGH']);

/**
 * 10 for a system that is not connected (Omer, 2026-10-04): its own screen —
 * the mark, the name, what it is, what it would bring, and Connect.
 *
 * How it connects is the catalogue's to say:
 *   · fields  — a credentials form, live.
 *   · OAuth   — at the provider. Live where the way back comes here
 *               (backend 381a5d1b: HubSpot, Salesforce, Monday); drawn, with
 *               why, where it still leads to the previous app.
 *   · neither — `custom_api`: set up with GOTCHA, not by a form; drawn.
 */
export async function AvailableSystem({ integration }: { readonly integration: Integration }) {
  const t = await getTranslations('capabilities');
  const { oauth, fields } = integration.authSchema;
  const line = [
    integration.category ? humaniseCode(integration.category) : null,
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
        </span>
        <span className={styles.systemActions}>
          <span className={styles.systemState} data-state="DISCONNECTED" data-testid="system-state">
            {t('available.notConnected')}
          </span>
        </span>
      </header>

      <section className={styles.connectCard} data-testid="connect-card">
        <h2 className={styles.connectHeading}>
          {t('available.connectTitle', { name: integration.name })}
        </h2>
        {!oauth && fields.length > 0 ? (
          <ConnectForm slug={integration.slug} name={integration.name} fields={fields} />
        ) : oauth && oauthHere(integration.slug, false) ? (
          <OAuthButton slug={integration.slug} name={integration.name} mode="connect" />
        ) : (
          <span
            className={styles.connectButton}
            aria-disabled="true"
            title={
              oauth
                ? t('available.oauthNotHere', { name: integration.name })
                : t('available.noForm')
            }
            data-testid="connect-drawn"
          >
            {t('available.connect')}
          </span>
        )}
      </section>

      <section className={styles.group} data-testid="available-brings">
        <h2 className={styles.groupHeading}>{t('available.brings')}</h2>
        {integration.catalogTools.length === 0 ? (
          <p className={styles.bringsNone} title={t('available.bringsNone')}>
            —
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
