'use server';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { notificationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

const unchecked = z.unknown();

export type PushPlatform = 'ios' | 'android';

/**
 * This phone receives this person's push notifications from now on.
 *
 * ★ Idempotent on the platform side (an upsert by token), so the bridge calls
 *   it on every app start: a token the OS rotated, or a phone now signed in as
 *   somebody else, is re-pointed rather than left delivering to the old one.
 *
 * Never throws: a failed registration costs this phone its notifications, not
 * the screen it was on. The next start tries again.
 */
export async function registerPushDevice(token: string, platform: PushPlatform): Promise<boolean> {
  if (token.length === 0 || token.length > 4096) return false;
  try {
    await serverApi().post({
      endpoint: notificationEndpoints.devices(),
      body: { token, platform },
      payload: unchecked,
      raw: true,
    });
    return true;
  } catch (cause) {
    logger.warn('mobile.push_register_failed', { cause, platform });
    return false;
  }
}

/**
 * This phone stops receiving this person's notifications - before signing out,
 * so a phone handed to somebody else does not keep showing a customer's words
 * on its lock screen.
 */
export async function forgetPushDevice(token: string): Promise<void> {
  if (token.length === 0 || token.length > 4096) return;
  try {
    await serverApi().delete({
      endpoint: notificationEndpoints.device(token),
      payload: unchecked,
      raw: true,
    });
  } catch (cause) {
    logger.warn('mobile.push_forget_failed', { cause });
  }
}
