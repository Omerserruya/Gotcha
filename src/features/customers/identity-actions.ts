'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { identityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type MergeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'gone' | 'conflict' | 'forbidden' | 'failed' };

/**
 * 04's "Merge them" — suggested, never silent: a person confirmed it on the
 * screen first. `POST /api/identity/merge { targetId, sourceId }` keeps every
 * message and order under the target.
 */
export async function mergeContacts(targetId: string, sourceId: string): Promise<MergeResult> {
  if (!targetId || !sourceId || targetId === sourceId) return { ok: false, reason: 'failed' };
  try {
    await serverApi().post({
      endpoint: identityEndpoints.merge(),
      payload: z.unknown(),
      body: { targetId, sourceId },
      raw: true,
    });
    revalidatePath('/[locale]/(app)/customers', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customers.merge_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 409) return { ok: false, reason: 'conflict' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
