'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  notificationPreferencesSchema,
  type EventChannel,
  type NotificationPreferences,
} from '@/api/contracts/notifications';
import { notificationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** The switches the platform has: one per channel, and approvals. */
export type PreferenceSwitchKey = 'inApp' | 'email' | 'whatsapp' | 'approvals';
const KEYS: readonly PreferenceSwitchKey[] = ['inApp', 'email', 'whatsapp', 'approvals'];

export type PreferenceSave =
  | { readonly ok: true; readonly preferences: NotificationPreferences }
  /** `phone`: WhatsApp on without a confirmed number (422 whatsapp_phone_required). */
  | { readonly ok: false; readonly reason: 'forbidden' | 'phone' | 'failed' };

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
    if (isApiError(cause) && cause.code === 'whatsapp_phone_required') {
      return { ok: false, reason: 'phone' };
    }
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

export type EventSave =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'forbidden' | 'unknown' | 'failed' };

/**
 * One event on one channel, for this person (notifications 63307535):
 * `PATCH {events:{<type>:{<channel>: on}}}`, which merges - nothing else is
 * sent. `UNKNOWN_EVENT` (400) is an event the workspace no longer has.
 */
export async function saveEventChannel(
  eventType: string,
  channel: EventChannel,
  on: boolean,
): Promise<EventSave> {
  if (
    (channel !== 'inApp' && channel !== 'email' && channel !== 'whatsapp') ||
    typeof on !== 'boolean' ||
    !eventType
  ) {
    return { ok: false, reason: 'failed' };
  }
  try {
    await serverApi().patch({
      endpoint: notificationEndpoints.preferences(),
      body: { events: { [eventType]: { [channel]: on } } },
      payload: notificationPreferencesSchema,
    });
    revalidatePath('/[locale]/settings/notifications', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    if (isApiError(cause) && cause.status === 400) return { ok: false, reason: 'unknown' };
    logger.warn('notification_settings.event_save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

/** Why a code was not sent, or not accepted - each said in its own words. */
export type WhatsAppRefusal =
  | 'invalid'
  | 'unavailable'
  | 'rateLimited'
  | 'sendFailed'
  | 'codeInvalid'
  | 'codeExpired'
  | 'forbidden'
  | 'failed';

const WHATSAPP_CODES: Readonly<Record<string, WhatsAppRefusal>> = {
  whatsapp_phone_invalid: 'invalid',
  whatsapp_unavailable: 'unavailable',
  whatsapp_rate_limited: 'rateLimited',
  whatsapp_send_failed: 'sendFailed',
  whatsapp_code_invalid: 'codeInvalid',
  whatsapp_code_expired: 'codeExpired',
};

function whatsappRefusal(cause: unknown, event: string): WhatsAppRefusal {
  if (isApiError(cause)) {
    const known = cause.code ? WHATSAPP_CODES[cause.code] : undefined;
    if (known) return known;
    if (cause.status === 429) return 'rateLimited';
    // support_denied:ownership, or an account with no preferences of its own.
    if (cause.status === 403) return 'forbidden';
  }
  logger.warn(event, { status: isApiError(cause) ? cause.status : undefined });
  return 'failed';
}

const verifySchema = z.object({ expiresInSeconds: z.number().int().positive().catch(600) });

/**
 * Sends a code to the number by WhatsApp (Backend 73f76d2c), the only way a
 * number is kept: an unverified one would be our number writing to a
 * stranger. Nothing is stored until the code comes back.
 */
export async function sendWhatsAppCode(
  phone: string,
): Promise<
  | { readonly ok: true; readonly expiresInSeconds: number }
  | { readonly ok: false; readonly reason: WhatsAppRefusal }
> {
  const number = phone.trim();
  if (!number) return { ok: false, reason: 'invalid' };
  try {
    const answer = await serverApi().post({
      endpoint: notificationEndpoints.whatsappVerify(),
      body: { phone: number },
      payload: verifySchema,
      raw: true,
    });
    return { ok: true, expiresInSeconds: answer.expiresInSeconds };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return {
      ok: false,
      reason: whatsappRefusal(cause, 'notification_settings.whatsapp_verify_failed'),
    };
  }
}

/** The code back: the number is kept, and WhatsApp alerts are on. */
export async function confirmWhatsAppCode(
  phone: string,
  code: string,
): Promise<
  | { readonly ok: true; readonly preferences: NotificationPreferences }
  | { readonly ok: false; readonly reason: WhatsAppRefusal }
> {
  const digits = code.trim();
  if (!/^\d{4,8}$/.test(digits)) return { ok: false, reason: 'codeInvalid' };
  try {
    const preferences = await serverApi().post({
      endpoint: notificationEndpoints.whatsappConfirm(),
      body: { phone: phone.trim(), code: digits },
      payload: notificationPreferencesSchema,
    });
    revalidatePath('/[locale]/settings/notifications', 'page');
    return { ok: true, preferences };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return {
      ok: false,
      reason: whatsappRefusal(cause, 'notification_settings.whatsapp_confirm_failed'),
    };
  }
}

/** The number removed: WhatsApp alerts off, and the opt-in cleared (`{whatsappPhone: null}`). */
export async function removeWhatsAppNumber(): Promise<PreferenceSave> {
  try {
    const preferences = await serverApi().patch({
      endpoint: notificationEndpoints.preferences(),
      body: { whatsappPhone: null },
      payload: notificationPreferencesSchema,
    });
    revalidatePath('/[locale]/settings/notifications', 'page');
    return { ok: true, preferences };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    logger.warn('notification_settings.whatsapp_remove_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
