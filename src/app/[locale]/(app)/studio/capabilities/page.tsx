import { getTranslations } from 'next-intl/server';

import { isConnected } from '@/api/contracts/integrations';
import { AvailableSystem } from '@/features/capabilities/AvailableSystem';
import { oauthFailure } from '@/features/capabilities/oauth';
import { OAuthLanding } from '@/features/capabilities/OAuthLanding';
import { CapabilityScreen } from '@/features/capabilities/CapabilityScreen';
import { IntegrationRail } from '@/features/capabilities/IntegrationRail';
import { selectSystem } from '@/features/capabilities/select-system';
import { SystemHead } from '@/features/capabilities/SystemHead';
import styles from '@/features/capabilities/Capabilities.module.css';
import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { StudioSplit } from '@/features/studio/StudioSplit';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · Capabilities — screen 10.
 *
 * ── NOT GROUPED BY RISK, AND THAT IS THE POINT ──
 * `riskGroup` arrives on every row and is **a regex over the tool's name**,
 * computed at response time, with `create_update` as its no-match fallback.
 * On this tenant `update_contact` lands in `sensitive_data` and `update_crm`
 * in `create_update` — **the same operation on the same data, separated
 * because one name contains the word "contact"**.
 *
 * Rendering that as a risk assessment would present a regex miss as a
 * judgement, so the screen groups by `category`, which is stored and real.
 *
 * ── AND WHAT IS ABSENT ──
 * **No usage or failure counts.** The only usage route reads `ToolExecution`,
 * which has zero rows here, and would report every tool as `"unknown"`
 * anyway because it selects the catalog name and never the denormalised
 * `toolName` added to survive a disconnect. The populated table,
 * `ToolExecutionRequest`, **has no route at all.**
 *
 * **No per-employee overrides** and **no limit-raise suggestions**; neither
 * has a source.
 *
 * **No numeric limits.** The design promises *"permission state and numeric
 * limits"*; no row carries one.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly system?: string;
    /** The way back from a provider (backend 381a5d1b). */
    readonly connected?: string;
    readonly error?: string;
  }>;
} = {}) {
  const t = await getTranslations('capabilities');
  const { capabilities, usage, integrations } = await loadCapabilities();
  const params = (await searchParams) ?? {};
  const { integration, actions, selected } = selectSystem(
    params.system,
    capabilities ?? [],
    integrations ?? [],
  );

  /*
    10, measured: 02's header — the title over a line that wraps at 720, no
    action — then the systems (290) beside the permissions (`26px 36px`).

    ★★ The rail and the permissions are SIBLINGS, never nested: both are
    async server components, and the structural test does not run a nested
    one. `StudioSplit` takes them as two props — still siblings.
  */
  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      flush
      narrowDescription
      title={t('title')}
      description={t('description')}
    >
      <StudioSplit
        label={t('rail.label')}
        listWidth="narrow"
        detailPad="wide"
        list={
          <IntegrationRail
            integrations={integrations}
            capabilities={capabilities}
            selected={selected}
          />
        }
        detail={
          <>
            {integration && (params.connected === '1' || params.error) ? (
              <OAuthLanding
                slug={integration.slug}
                name={integration.name}
                outcome={params.connected === '1' ? 'connected' : oauthFailure(params.error)!}
              />
            ) : null}
            {integration !== null && !isConnected(integration) ? (
              <AvailableSystem integration={integration} />
            ) : capabilities === null ? (
              <p data-testid="capabilities-unavailable">{t('unavailable')}</p>
            ) : capabilities.length === 0 ? (
              <div className={styles.empty} data-testid="capabilities-empty">
                <p className={styles.emptyLead}>{t('none')}</p>
                <p className={styles.emptyBody}>{t('noneBody')}</p>
              </div>
            ) : (
              <>
                <SystemHead integration={integration} capabilities={actions} usage={usage} />
                <CapabilityScreen capabilities={actions} usage={usage} integration={integration} />
              </>
            )}
          </>
        }
      />
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
