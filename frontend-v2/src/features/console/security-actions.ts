'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type RemoveResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'gone' | 'failed' };

/**
 * Removes one of the admin's own factors (legacy `removeMfaDevice`). The
 * route checks the device is the caller's and of that type, and clears the
 * enrolment stamp, so the gate asks again if what is left is not enough.
 */
export async function removeMyFactor(type: 'totp' | 'static', id: string): Promise<RemoveResult> {
  try {
    await serverApi().delete({
      endpoint: securityEndpoints.removeMfaDevice(type, id),
      payload: z.unknown(),
      raw: true,
    });
    revalidatePath('/[locale]/system/security', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 404) return { ok: false, reason: 'gone' };
    logger.warn('console.factor_remove_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
