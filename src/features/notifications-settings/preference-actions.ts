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
