import { getTranslations } from 'next-intl/server';

import { loadRules } from '@/features/notifications-settings/load-rules';
import { RuleTable } from '@/features/notifications-settings/RuleTable';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Notifications — screen 15.
 *
 * *"GOTCHA never pings you for an incoming message — that's what the inbox is
 * for. It tells you when something needs a decision or something broke."*
 *
 * The design drew a personal matrix. That store exists and nothing reads it:
 * `UserNotificationPreference` has two references in the whole repository and
 * both are its own route. What the dispatcher reads is the TENANT rule table,
 * so that is what this screen configures — a different question, and the one
 * with an answer.
 *
 * Absent, and not softened: quiet hours (enforced by nothing), the WhatsApp
 * destination (approval authority on `ApprovalRecipient`, not a contact
 * detail), and any per-user switch.
 */
export default async function Page() {
  const t = await getTranslations('notifications-settings');
  const { rules, available } = await loadRules();

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <RuleTable rules={rules} available={available} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.notifications');
