import { getTranslations } from 'next-intl/server';

import { loadSystems } from '@/features/systems/load-systems';
import { SystemsList } from '@/features/systems/SystemsList';
import { pageMetadata } from '@/shell/page-metadata';
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
  const { integrations, permissions, policyLoaded } = await loadSystems();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {integrations ? (
        <SystemsList
          integrations={integrations}
          permissions={permissions}
          policyLoaded={policyLoaded}
        />
      ) : (
        <p>{t('unavailable')}</p>
      )}
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.systems');
