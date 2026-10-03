import { getTranslations } from 'next-intl/server';

import { loadPreferences } from '@/features/notifications-settings/load-preferences';
import { loadRules } from '@/features/notifications-settings/load-rules';
import { PreferenceMatrix } from '@/features/notifications-settings/PreferenceMatrix';
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
  const [{ rules, departments, members }, { preferences, volume, whatsappDestination }] =
    await Promise.all([loadRules(), loadPreferences()]);

  /*
    15, measured: "Tell me when" × In app · Email · WhatsApp, then quiet
    hours, where WhatsApp alerts go, and how many arrive. The workspace's
    rules — who is told at all — stay below: the matrix only filters them.
  */
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <PreferenceMatrix
        preferences={preferences}
        volume={volume}
        whatsappDestination={whatsappDestination}
      />
      <RuleTable rules={rules} departments={departments} members={members} />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.notifications');
