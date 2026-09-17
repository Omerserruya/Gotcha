import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import {
  notificationPageSchema,
  notificationPreferencesSchema,
  type NotificationPreferences,
} from '@/api/contracts/notifications';
import { authEndpoints, notificationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { observedVolume, VOLUME_WINDOW_DAYS, type ObservedVolume } from './volume';

/**
 * What screen 15 shows.
 *
 * Three reads, all degrading independently:
 *
 *   - the preferences themselves, which are the screen;
 *   - the newest page of notifications, to count observed volume;
 *   - the current user, for the phone number WhatsApp alerts would reach.
 *
 * The last one is worth a word. `UserNotificationPreference` has a `whatsapp`
 * boolean and **no number** — the destination is the person's own
 * `User.phoneNumber`, and it is not settable from here. So the screen states
 * where alerts go and where that is changed, rather than drawing a field that
 * writes nowhere.
 */
export interface PreferencesData {
  readonly preferences: NotificationPreferences | null;
  readonly volume: ObservedVolume | null;
  /** Where WhatsApp alerts would go. `null` when the person has no number. */
  readonly whatsappDestination: string | null;
}

export async function loadPreferences(now: Date = new Date()): Promise<PreferencesData> {
  const api = serverApi();

  const [preferences, page, me] = await Promise.all([
    api
      .get({
        endpoint: notificationEndpoints.preferences(),
        payload: notificationPreferencesSchema,
      })
      .catch((cause: unknown) => {
        logger.warn('notification_settings.preferences_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: notificationEndpoints.list(),
        payload: notificationPageSchema,
        // The largest page the route allows, so the count reaches as far back
        // as one round trip can.
        query: { limit: 200 },
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('notification_settings.volume_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
      .catch((cause: unknown) => {
        logger.warn('notification_settings.me_failed', { cause });
        return null;
      }),
  ]);

  return {
    preferences,
    volume: page
      ? observedVolume(page.data, page.nextCursor != null, now, VOLUME_WINDOW_DAYS)
      : null,
    // `phoneNumber` is on the member record; absent is absent, never a
    // placeholder number.
    whatsappDestination:
      (me?.user as { phoneNumber?: string | null } | undefined)?.phoneNumber?.trim() || null,
  };
}
