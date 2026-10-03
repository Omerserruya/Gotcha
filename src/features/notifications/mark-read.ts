'use server';

import { z } from 'zod';

import { notificationEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';
import { revalidatePath } from 'next/cache';

/**
 * Marking read.
 *
 * Both endpoints take no body and answer `{ ok: true }`. A single mark is
 * scoped server-side to `(id, tenantId, userId)`, so another user's id answers
 * 404 rather than leaking that the notification exists — worth knowing when
 * reading the failure path below: a 404 here is a normal outcome, not a bug.
 */
export async function markRead(id: string): Promise<{ ok: boolean }> {
  return dispatch(() =>
    serverApi().post({
      endpoint: notificationEndpoints.markRead(id),
      payload: z.unknown(),
      raw: true,
    }),
  );
}

export async function markAllRead(): Promise<{ ok: boolean }> {
  return dispatch(() =>
    serverApi().post({
      endpoint: notificationEndpoints.markAllRead(),
      payload: z.unknown(),
      raw: true,
    }),
  );
}

async function dispatch(call: () => Promise<unknown>): Promise<{ ok: boolean }> {
  try {
    await call();
    // The unread count is rendered on the server, so it has to be re-read.
    revalidatePath('/[locale]/(app)/home', 'page');
    return { ok: true };
  } catch (cause) {
    logger.warn('notifications.mark_read_failed', { cause });
    return { ok: false };
  }
}
