import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  notificationPageSchema,
  notificationPreferencesSchema,
  type NotificationPreferences,
} from '@/api/contracts/notifications';
import { notificationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { observedVolume, VOLUME_WINDOW_DAYS, type ObservedVolume } from './volume';

/**
 * What screen 15 shows.
 *
 * Two reads, degrading independently:
 *
 *   - the preferences themselves, which are the screen - with the person's
 *     own WhatsApp number now, kept by a code (Backend 73f76d2c), not the
 *     member record's `phoneNumber` the screen used to name;
 *   - the newest page of notifications, to count observed volume.
 */
export interface PreferencesData {
  readonly preferences: NotificationPreferences | null;
  readonly volume: ObservedVolume | null;
}

export async function loadPreferences(now: Date = new Date()): Promise<PreferencesData> {
  const api = serverApi();

  const [preferences, page] = await Promise.all([
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
  ]);

  return {
    preferences,
    volume: page
      ? observedVolume(page.data, page.nextCursor != null, now, VOLUME_WINDOW_DAYS)
      : null,
  };
}
