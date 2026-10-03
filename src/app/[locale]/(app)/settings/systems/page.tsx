import { getTranslations } from 'next-intl/server';

import { pageMetadata } from '@/shell/page-metadata';
import { BusinessCore } from '@/features/integrations/BusinessCore';
import { loadBusinessCore } from '@/features/integrations/load-business-core';
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
export default async function Page() {
  const t = await getTranslations('systems');
  const core = await loadBusinessCore();

  /*
    14, measured: which system plays which part. The connections themselves
    are 10's (Studio · Integrations); the inventory that stood below the parts
    duplicated it and is gone — the footer says where connecting lives.
  */
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <BusinessCore core={core} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.systems');
