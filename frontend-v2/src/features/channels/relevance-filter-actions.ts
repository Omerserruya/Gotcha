'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type RelevanceFilterProblem = 'not_applicable' | 'not_found' | 'forbidden' | 'failed';

export type RelevanceFilterResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: RelevanceFilterProblem };

/**
 * A channel account's "personal and not relevant" filter, on or off
 * (PATCH /api/channels/:id/relevance-filter, Backend 2026-11-18). Per account:
 * two mailboxes, or two WhatsApp numbers, can differ.
 *
 * Refusals: 400 `RELEVANCE_FILTER_NOT_APPLICABLE` a channel it never runs on,
 * 403 no `channels:manage:update`, 404 not this workspace's. Anything else,
 * `INVALID_RELEVANCE_FILTER` and 500 included, is "not saved".
 */
export async function setRelevanceFilter(
  id: string,
  enabled: boolean,
): Promise<RelevanceFilterResult> {
  if (typeof enabled !== 'boolean' || id.length === 0) return { ok: false, reason: 'failed' };
  try {
    await serverApi().patch({
      endpoint: channelEndpoints.relevanceFilter(id),
      payload: z.unknown(),
      raw: true,
      body: { relevanceFilterEnabled: enabled },
    });
    revalidatePath('/[locale]/settings/channels', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const status = isApiError(cause) ? cause.status : undefined;
    const code = isApiError(cause) ? cause.code : undefined;
    logger.warn('channels.relevance_filter_failed', { status, code });
    if (status === 400 && code === 'RELEVANCE_FILTER_NOT_APPLICABLE') {
      return { ok: false, reason: 'not_applicable' };
    }
    if (status === 404) return { ok: false, reason: 'not_found' };
    if (status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  }
}
