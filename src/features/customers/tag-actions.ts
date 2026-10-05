'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { FACTS_BATCH, TAG_MAX, tagsAnswerSchema } from '@/api/contracts/customer-facts';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type TagResult =
  | { readonly ok: true; readonly tagged: number }
  | {
      readonly ok: false;
      readonly reason:
        'invalid' | 'too_many_people' | 'too_many_tags' | 'not_found' | 'forbidden' | 'failed';
    };

/**
 * 04's selection bar: one tag on every picked person (backend 01bb7b6e).
 * All or nothing on the server — a tag half-applied would leave a selection
 * nobody chose — so more than one call's worth is refused here rather than
 * split into calls that could half-succeed. Exact match: "VIP" and "vip" are
 * two tags, as decided.
 *
 * It writes to real contacts: no test or capture presses it live.
 */
export async function tagCustomers(contactIds: readonly string[], tag: string): Promise<TagResult> {
  const name = tag.trim();
  if (name.length < 1 || name.length > TAG_MAX) return { ok: false, reason: 'invalid' };
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return { ok: false, reason: 'invalid' };
  if (ids.length > FACTS_BATCH) return { ok: false, reason: 'too_many_people' };
  try {
    const answer = await serverApi().post({
      endpoint: customerEndpoints.tags(),
      payload: tagsAnswerSchema,
      body: { contactIds: ids, add: [name] },
      raw: true,
    });
    revalidatePath('/[locale]/(app)/customers', 'page');
    return { ok: true, tagged: Object.keys(answer.data).length };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('customers.tag_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
      if (cause.developerMessage === 'too_many_tags') return { ok: false, reason: 'too_many_tags' };
      if (cause.status === 400) return { ok: false, reason: 'invalid' };
    }
    return { ok: false, reason: 'failed' };
  }
}
