import { getTranslations } from 'next-intl/server';

import { loadSystems } from '@/features/systems/load-systems';
import { SystemsList } from '@/features/systems/SystemsList';
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
  const [{ integrations, permissions, policyLoaded }, core] = await Promise.all([
    loadSystems(),
    loadBusinessCore(),
  ]);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {/*
        Screens 14b/14c, ABOVE the connected-systems list.

        The parts are what a merchant came to configure; the list below is the
        inventory they configure them FROM. Reading the inventory first means
        holding it in your head until the parts explain what it is for.

        It renders whatever the list does — a failed `loadSystems` does not
        hide the parts, because they answer a different question.
      */}
      <BusinessCore core={core} />

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
