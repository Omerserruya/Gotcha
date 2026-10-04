'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { goLiveEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type GoLiveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'store' | 'profile' | 'admin' | 'forbidden' | 'failed';
    };

/**
 * Go live — a write that puts GOTCHA in front of real customers, made only
 * on the owner's second press. The route's own guards stand: it is never
 * told to skip the store.
 */
export async function goLive(): Promise<GoLiveResult> {
  try {
    await serverApi().post({
      endpoint: goLiveEndpoints.complete(),
      payload: z.unknown(),
      body: { skipEmployee: true },
      raw: true,
    });
    revalidatePath('/[locale]/(app)/home', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('home.go_live_failed', { status: isApiError(cause) ? cause.status : undefined });
    if (isApiError(cause)) {
      const said = cause.developerMessage ?? '';
      if (said === 'core_system_required') return { ok: false, reason: 'store' };
      if (/business profile/i.test(said)) return { ok: false, reason: 'profile' };
      if (/admin account/i.test(said)) return { ok: false, reason: 'admin' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
