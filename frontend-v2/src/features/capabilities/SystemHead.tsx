import { getFormatter, getTranslations } from 'next-intl/server';

import { usageFor, type Capability, type ToolUsage } from '@/api/contracts/capabilities';
import { isIntegrationState, type Integration } from '@/api/contracts/integrations';
import { platformErrorReason } from '@/api/contracts/platform-errors';

import { DisconnectSystem } from './DisconnectSystem';
import { IntegrationLogo } from './IntegrationLogo';
import styles from './Capabilities.module.css';

/**
 * 10's detail header: the selected system - a 38px tile, its name (16/600),
 * how often its actions ran, and its connection on the right.
 *
 * ⚠ 02 says "Used 1,840 times this week". `/tool-usage` is read without a
 * range, which the route answers with the LAST 30 DAYS - so the line names
 * that window, and the rows below it inherit it.
 *
 * "Narrow it for one employee" is drawn, not live: there are no
 * per-employee overrides.
 *
 * ★★ DISCONNECT LIVES HERE (Omer, 2026-10-11: "why is there no disconnect
 *   for integrations?"). It was drawn after the system's whole action list -
 *   945px down for WooCommerce at 1440x900, further for Shopify - so for a
 *   person it did not exist. In the head it is in view on arrival; its
 *   confirmation opens as a full-width line under the row.
 */
export async function SystemHead({
  integration,
  capabilities,
  usage,
  disconnect = false,
}: {
  /** `null` for the built-in actions, which belong to no provider. */
  readonly integration: Integration | null;
  /** This system's actions. */
  readonly capabilities: readonly Capability[];
  readonly usage: readonly ToolUsage[] | null;
  /** Offer Disconnect in the head: a connected system that is not broken (a broken one has it beside its Reconnect). */
  readonly disconnect?: boolean;
}) {
  const t = await getTranslations('capabilities');
  const format = await getFormatter();
  const runs =
    usage === null
      ? null
      : capabilities.reduce(
          (sum, capability) => sum + (usageFor(capability.toolName, usage)?.executionCount ?? 0),
          0,
        );
  const state = integration?.tenantConnection?.status ?? null;
  // Its last error in the reader's words (ai 272ee282) - never the platform's English.
  const tp = await getTranslations('common.platformError');
  const reason = platformErrorReason(
    integration?.tenantConnection?.lastError,
    integration?.tenantConnection?.lastErrorCode,
  );

  return (
    <header className={styles.systemHead} data-testid="system-head">
      <IntegrationLogo slug={integration?.slug ?? null} size="head" />
      <span className={styles.systemTitle}>
        <span className={styles.systemName}>{integration?.name ?? t('rail.builtIn')}</span>
        <span className={styles.systemLine} data-testid="system-line">
          {runs === null
            ? t('system.actions', { count: capabilities.length })
            : t('system.used', { count: runs, n: format.number(runs) })}
        </span>
        {reason ? (
          <span className={styles.systemError} role="note" data-testid="system-error">
            {reason === 'unknown'
              ? t('reconnect.unknown', { name: integration?.name ?? '' })
              : tp(reason)}
          </span>
        ) : null}
      </span>
      <span className={styles.systemActions}>
        {integration ? (
          <span
            className={styles.systemState}
            data-state={state ?? undefined}
            data-testid="system-state"
          >
            {state && isIntegrationState(state)
              ? t(`rail.state.${state}` as 'rail.state.CONNECTED')
              : t('rail.stateUnknown')}
          </span>
        ) : null}
        <span className={styles.systemNarrow} aria-disabled="true" title={t('system.narrowNotYet')}>
          {t('system.narrow')}
        </span>
      </span>
      {disconnect && integration ? (
        <DisconnectSystem slug={integration.slug} name={integration.name} />
      ) : null}
    </header>
  );
}
