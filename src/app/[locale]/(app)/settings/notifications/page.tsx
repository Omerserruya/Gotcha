import { getTranslations } from 'next-intl/server';

import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · notifications.
 *
 * The section's frame is real - title, description and the sidebar entry that
 * reaches it. The content is built section by section against what the backend
 * serves; see docs/settings-contract.md for which parts are blocked and why.
 */
export default async function Page() {
  const t = await getTranslations('navigation');
  return (
    <SettingsSection
      title={t('settings.notifications')}
      description={t('settingsDescription.notifications')}
    />
  );
}

export const generateMetadata = pageMetadata('settings.notifications');
