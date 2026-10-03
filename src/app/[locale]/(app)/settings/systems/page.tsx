import { getTranslations } from 'next-intl/server';

import { pageMetadata } from '@/shell/page-metadata';
import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { AcrossDrawer } from '@/features/integrations/AcrossDrawer';
import { BusinessCore } from '@/features/integrations/BusinessCore';
import { PartDrawer } from '@/features/integrations/PartDrawer';
import { loadBusinessCore } from '@/features/integrations/load-business-core';
import { Drawer } from '@/shell/Drawer';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Business systems — screen 14.
 *
 * *"Platform config, no AI behaviour."*
 *
 * Two reads, and the second is the authoritative one: what a capability may
 * actually do comes from the tenant's tool POLICY, not from whether the tool
 * is activated. On this tenant those disagree.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly part?: string; readonly panel?: string }>;
}) {
  const t = await getTranslations('systems');
  const tb = await getTranslations('business-core');
  const params = (await searchParams) ?? {};
  const core = await loadBusinessCore();
  const part = params.part ? (core?.roles.find((r) => r.role === params.part) ?? null) : null;
  // 10's actions, only when a part's drawer needs them.
  const capabilities = part ? (await loadCapabilities()).capabilities : null;

  /*
    14, measured: which system plays which part. The connections themselves
    are 10's (Studio · Integrations); the inventory that stood below the parts
    duplicated it and is gone — the footer says where connecting lives.
  */
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <BusinessCore core={core} />

      {/* 14c / 14d: a part's drawer; 14e: across both. */}
      {part ? (
        <Drawer
          title={tb(`part.${part.role}`)}
          line={tb(`purpose.${part.role}`)}
          closeHref="/settings/systems"
          width={600}
          testId="drawer-part"
        >
          <PartDrawer part={part} capabilities={capabilities} />
        </Drawer>
      ) : params.panel === 'across' && core ? (
        <Drawer
          title={tb('drawer.acrossTitle')}
          line={tb('drawer.acrossLine')}
          closeHref="/settings/systems"
          width={820}
          testId="drawer-across"
        >
          <AcrossDrawer crm={core.roles.find((r) => r.role === 'crm') ?? null} />
        </Drawer>
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.systems');
