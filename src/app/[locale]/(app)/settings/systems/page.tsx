import { getLocale, getTranslations } from 'next-intl/server';

import { connectedButFailing } from '@/api/contracts/business-core';
import { displayHost } from '@/api/contracts/workspace';

import { pageMetadata } from '@/shell/page-metadata';
import { loadCapabilities } from '@/features/capabilities/load-capabilities';
import { AcrossDrawer } from '@/features/integrations/AcrossDrawer';
import { BusinessCore } from '@/features/integrations/BusinessCore';
import { PartDrawer } from '@/features/integrations/PartDrawer';
import { loadLanguages } from '@/features/workspace/load-languages';
import { loadWorkspace } from '@/features/workspace/load-workspace';
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
  const locale = await getLocale();
  const params = (await searchParams) ?? {};
  const core = await loadBusinessCore();
  const part = params.part ? (core?.roles.find((r) => r.role === params.part) ?? null) : null;
  // 10's actions and the system's record, only when a part's drawer needs them.
  const [capabilityData, workspace] = part
    ? await Promise.all([loadCapabilities(), loadWorkspace().then((w) => w.workspace)])
    : [null, null];
  const capabilities = capabilityData?.capabilities ?? null;
  const playingSlug =
    part?.elected?.slug ?? part?.candidates.find((c) => connectedButFailing(c))?.slug ?? null;
  const integration = capabilityData?.integrations?.find((i) => i.slug === playingSlug) ?? null;
  /*
    The store's host is the workspace website's ONLY when that website is
    this Shopify store — a `*.myshopify.com` address — not a guess.
  */
  const host = workspace?.websiteDomain ? displayHost(workspace.websiteDomain) : null;
  const storeHost =
    part?.role === 'ecommerce' && playingSlug === 'shopify' && host?.endsWith('.myshopify.com')
      ? host
      : null;
  // 14e names the workspace language GOTCHA writes its own words in.
  const systemLocale = params.panel === 'across' ? (await loadLanguages()).systemLocale : null;
  const acrossLanguage = systemLocale
    ? (new Intl.DisplayNames([locale], { type: 'language' }).of(systemLocale) ?? null)
    : null;
  /* 02 writes the drawer's line as a sentence: "The catalogue and orders." */
  const sentence = (text: string) => `${text.charAt(0).toLocaleUpperCase(locale)}${text.slice(1)}.`;

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
          line={sentence(tb(`purpose.${part.role}`))}
          closeHref="/settings/systems"
          width={600}
          testId="drawer-part"
        >
          <PartDrawer
            part={part}
            capabilities={capabilities}
            integration={integration}
            storeHost={storeHost}
          />
        </Drawer>
      ) : params.panel === 'across' && core ? (
        <Drawer
          title={tb('drawer.acrossTitle')}
          line={tb('drawer.acrossLine')}
          closeHref="/settings/systems"
          width={820}
          testId="drawer-across"
        >
          <AcrossDrawer
            crm={core.roles.find((r) => r.role === 'crm') ?? null}
            language={acrossLanguage}
          />
        </Drawer>
      ) : null}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.systems');
