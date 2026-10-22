import { getTranslations } from 'next-intl/server';

import { loadPreferences } from '@/features/notifications-settings/load-preferences';
import { PreferenceMatrix } from '@/features/notifications-settings/PreferenceMatrix';
import { pageMetadata } from '@/shell/page-metadata';
import { SettingsSection } from '@/shell/SettingsSection';

/**
 * Settings · Notifications - screen 15.
 *
 * The design's line was *"GOTCHA never pings you for an incoming message"*.
 * Omer asked for one (2026-10-11): a chime, and a desktop notification, per
 * device - so the line now says what the page does, and the device's two
 * switches sit under the matrix (`DeviceAlerts`).
 *
 * The design drew a personal matrix, and since notifications 9164a058 the
 * fan-out obeys it: each person's channel switches, approvals, and quiet
 * hours (see PreferenceMatrix). Who is told at all is the TENANT rule table,
 * configured on its own page (`./rules`); with no rule for an event, GOTCHA's
 * own route (in-app: the assignee, else the admins).
 *
 * Absent, and not softened: the WhatsApp destination (approval authority on
 * `ApprovalRecipient`, not a contact detail) - WhatsApp to a person is not
 * deliverable.
 */
export default async function Page() {
  const t = await getTranslations('notifications-settings');
  const { preferences, volume, whatsappDestination } = await loadPreferences();

  /*
    15, measured: "Tell me when" × In app · Email · WhatsApp, then quiet
    hours, where WhatsApp alerts go, and how many arrive. The workspace's
    rules - who is told at all - are their own page (/rules), linked from
    the matrix's foot: the matrix only filters them.
  */
  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <PreferenceMatrix
        preferences={preferences}
        volume={volume}
        whatsappDestination={whatsappDestination}
      />
    </SettingsSection>
  );
}

export const generateMetadata = pageMetadata('settings.notifications');
