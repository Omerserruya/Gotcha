'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { identityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type AcceptResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'gone' | 'not_same' | 'forbidden' | 'failed' };

/**
 * 04's "Merge them" on a pair the server suggested - suggested, never silent:
 * a person confirmed it on the screen first. `POST
 * /api/identity/suggestions/accept { contactIds: [a, b] }` (Backend 83579ac8)
 * links the two as one person: both stay, nothing is overwritten, and the
 * list shows them as one. 404 CONTACT_NOT_FOUND, 409 NOT_SAME (marked as two
 * people, or a link undone before).
 */
export async function acceptSuggestion(a: string, b: string): Promise<AcceptResult> {
  if (!a || !b || a === b) return { ok: false, reason: 'failed' };
  try {
    await serverApi().post({
      endpoint: identityEndpoints.acceptSuggestion(),
      payload: z.unknown(),
      body: { contactIds: [a, b] },
      raw: true,
    });
    revalidatePath('/[locale]/(app)/customers', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customers.accept_suggestion_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 409) return { ok: false, reason: 'not_same' };
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
 * 04's "Not the same": the pair is remembered as two people, and
 * `GET /api/identity/suggestions` never lists it again (conversation
 * e5a56fd3). Idempotent.
 *
 * `POST /api/identity/not-same`, not `/unlink`: a suggested pair was never
 * linked, and `unlinkContacts` answers 404 NOT_LINKED for it and records
 * nothing (packages/shared/src/lib/identity-links.ts). Unlink undoes an
 * automatic link, which 04 does not show.
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
