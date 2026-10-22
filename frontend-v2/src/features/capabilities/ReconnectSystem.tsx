import { getTranslations } from 'next-intl/server';

import type { Integration } from '@/api/contracts/integrations';
import { platformErrorReason } from '@/api/contracts/platform-errors';

import { ConnectFor } from './ConnectFor';
import { DisconnectSystem } from './DisconnectSystem';
import styles from './Capabilities.module.css';

/**
 * 10 for a connected system whose connection broke: what that means, and the
 * way back - the same flow the system connects with (`ConnectFor`), as a
 * Reconnect.
 *
 * `ERROR` pauses its actions - the AI's tools are built only from `CONNECTED`
 * rows (`tool-registry.ts`). A failed last check on a `CONNECTED` row does
 * not, and is said as that.
 *
 * The reason is the code's, in words; the stored sentence never is (dev's
 * Shopify row holds a raw HTML 401 page). `showReason` is for when the header
 * that normally carries it is not drawn.
 *
 * ★ And the other way out: Disconnect, beside Reconnect - a broken system is
 *   exactly one somebody may want to let go of (Omer, 2026-10-11).
 */
export async function ReconnectSystem({
  integration,
  showReason,
}: {
  readonly integration: Integration;
  readonly showReason: boolean;
}) {
  const t = await getTranslations('capabilities');
  const tp = await getTranslations('common.platformError');
  const connection = integration.tenantConnection;
  const name = integration.name;
  const reason = platformErrorReason(connection?.lastError, connection?.lastErrorCode);

  return (
    <section className={styles.connectCard} data-testid="reconnect-card">
      <h2 className={styles.connectHeading}>{t('reconnect.title', { name })}</h2>
      <p className={styles.connectLead} data-testid="reconnect-what">
        {connection?.status === 'ERROR'
          ? t('reconnect.paused', { name })
          : t('reconnect.checkFailed', { name })}
      </p>
      {showReason && reason ? (
        <p className={styles.systemError} role="note" data-testid="reconnect-reason">
          {reason === 'unknown' ? t('reconnect.unknown', { name }) : tp(reason)}
        </p>
      ) : null}
      <ConnectFor
        integration={integration}
        reconnect
        drawn={{
          connect: t('oauth.reconnect', { name }),
          oauthNotHere: t('available.oauthNotHere', { name }),
          noForm: t('available.noForm'),
        }}
      />
      <DisconnectSystem slug={integration.slug} name={integration.name} />
    </section>
  );
}
