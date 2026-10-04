import { getFormatter, getTranslations } from 'next-intl/server';

import { usageFor, type Capability, type ToolUsage } from '@/api/contracts/capabilities';
import { isIntegrationState, type Integration } from '@/api/contracts/integrations';

import { IntegrationLogo } from './IntegrationLogo';
import styles from './Capabilities.module.css';

/**
 * 10's detail header: the selected system — a 38px tile, its name (16/600),
 * how often its actions ran, and its connection on the right.
 *
 * ⚠ 02 says "Used 1,840 times this week". `/tool-usage` is read without a
 * range, which the route answers with the LAST 30 DAYS — so the line names
 * that window, and the rows below it inherit it.
 *
 * "Narrow it for one employee" is drawn, not live: there are no
 * per-employee overrides.
 */
export async function SystemHead({
  integration,
  capabilities,
  usage,
}: {
  /** `null` for the built-in actions, which belong to no provider. */
  readonly integration: Integration | null;
  /** This system's actions. */
  readonly capabilities: readonly Capability[];
  readonly usage: readonly ToolUsage[] | null;
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
    </header>
  );
}
