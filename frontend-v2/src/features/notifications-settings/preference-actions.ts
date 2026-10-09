'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  notificationPreferencesSchema,
  type NotificationPreferences,
} from '@/api/contracts/notifications';
import { notificationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** The switches the platform has: one per channel, and approvals. */
export type PreferenceSwitchKey = 'inApp' | 'email' | 'whatsapp' | 'approvals';
const KEYS: readonly PreferenceSwitchKey[] = ['inApp', 'email', 'whatsapp', 'approvals'];

export type PreferenceSave =
  | { readonly ok: true; readonly preferences: NotificationPreferences }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/**
 * One of the person's own switches - `PATCH /api/notification-preferences/me`,
 * which writes only the caller's row (keyed by their user, in their
 * workspace). Nothing else is sent: one key, a boolean.
 */
export async function savePreferenceSwitch(
  key: PreferenceSwitchKey,
  on: boolean,
): Promise<PreferenceSave> {
  if (!KEYS.includes(key) || typeof on !== 'boolean') return { ok: false, reason: 'failed' };
  try {
    const preferences = await serverApi().patch({
      endpoint: notificationEndpoints.preferences(),
      body: { [key]: on },
      payload: notificationPreferencesSchema,
    });
    revalidatePath('/[locale]/settings/notifications', 'page');
    return { ok: true, preferences };
  } catch (cause) {
    await signInIfSignedOut(cause);
    // 403 "Preferences are per-user": an internal account has none.
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    logger.warn('notification_settings.save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

/** "HH:MM", 24-hour - what the route keeps, and rejects otherwise. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type QuietHoursSave =
  | { readonly ok: true; readonly preferences: NotificationPreferences }
  | { readonly ok: false; readonly reason: 'invalid' | 'forbidden' | 'failed' };

/**
 * Quiet hours - one daily window, or none (`quietHours: null` clears both
 * ends together). A window may wrap midnight (22:00 to 07:00); from and to
 * may not be the same time. Checked here as the route checks it.
 */
export async function saveQuietHours(
  window: { readonly from: string; readonly to: string } | null,
): Promise<QuietHoursSave> {
  if (
    window !== null &&
    (!HHMM.test(window.from) || !HHMM.test(window.to) || window.from === window.to)
  ) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    const preferences = await serverApi().patch({
      endpoint: notificationEndpoints.preferences(),
      body: { quietHours: window === null ? null : { from: window.from, to: window.to } },
      payload: notificationPreferencesSchema,
    });
    revalidatePath('/[locale]/settings/notifications', 'page');
    return { ok: true, preferences };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    if (isApiError(cause) && cause.status === 400) return { ok: false, reason: 'invalid' };
    logger.warn('notification_settings.quiet_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
