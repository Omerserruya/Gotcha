import { getTranslations } from 'next-intl/server';

import { loadRules } from '@/features/notifications-settings/load-rules';
import { RuleTable } from '@/features/notifications-settings/RuleTable';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Notifications · the workspace's rules — who is told at all.
 *
 * Not drawn in 02. 15's matrix only filters what reaches one person; this is
 * what the dispatcher reads, so it is reached from the matrix's foot line and
 * keeps 17b's shape: "← Notifications" above the title.
 */
export default async function Page() {
  const t = await getTranslations('notifications-settings.rulesPage');
  const nav = await getTranslations('navigation');
  const { rules, departments, members } = await loadRules();

  return (
    <SettingsSection
      title={t('title')}
      description={t('description')}
      back={{ href: '/settings/notifications', label: nav('settings.notifications') }}
    >
      <RuleTable rules={rules} departments={departments} members={members} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.notifications');
