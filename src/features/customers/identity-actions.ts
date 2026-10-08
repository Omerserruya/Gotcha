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
 * 04's "Merge them" - suggested, never silent: a person confirmed it on the
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

export type NotSameResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'gone' | 'already_same' | 'forbidden' | 'failed';
    };

/**
 * 04's "Not the same": the pair is remembered as two people and never
 * suggested together again (conversation e5a56fd3). Idempotent; a merge of
 * the pair later still works, and clears the mark.
 */
export async function markNotSame(a: string, b: string): Promise<NotSameResult> {
  if (!a || !b || a === b) return { ok: false, reason: 'failed' };
  try {
    await serverApi().post({
      endpoint: identityEndpoints.notSame(),
      payload: z.unknown(),
      body: { contactIds: [a, b] },
      raw: true,
    });
    revalidatePath('/[locale]/(app)/customers', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customers.not_same_mark_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.code === 'ALREADY_SAME_PERSON') return { ok: false, reason: 'already_same' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
