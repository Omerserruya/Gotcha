'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { resolveConflict, type ResolveResult } from '@/features/knowledge/resolve-actions';
import { logger } from '@/observability/logger';

const CHANNELS = '/[locale]/(app)/settings/channels';

/**
 * 13f's Approve, "Use this one" and Edit - live (Omer, decision 13): one
 * route, the answer always sent (the chosen variant, the edit, or the
 * suggestion as it stands). It goes into the knowledge base that answers
 * customers. The refusals are 08's, already named there.
 */
export async function approveSuggestion(
  candidateId: string,
  answer: string,
): Promise<ResolveResult> {
  const result = await resolveConflict(candidateId, answer);
  if (result.ok || result.reason === 'already_covered') revalidatePath(CHANNELS, 'page');
  return result;
}

export type RejectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' | 'forbidden' | 'failed' };

/** 13f's Reject / Skip: the suggestion is set aside; nothing reaches customers. */
export async function rejectSuggestion(candidateId: string): Promise<RejectResult> {
  try {
    await serverApi().post({
      endpoint: knowledgeEndpoints.rejectCandidate(candidateId),
      payload: z.unknown(),
      body: {},
      raw: true,
    });
    revalidatePath(CHANNELS, 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.suggestion_reject_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
      if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type BulkResult =
  | { readonly ok: true; readonly approved: number; readonly skipped: number }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/** Adds every ready answer at once - after the owner's second press. */
export async function addReadyAnswers(importId: string): Promise<BulkResult> {
  try {
    const done = await serverApi().post({
      endpoint: knowledgeEndpoints.bulkApprove(importId),
      payload: z.object({
        approved: z.number().catch(0).default(0),
        skipped: z.number().catch(0).default(0),
      }),
      body: {},
      raw: true,
    });
    revalidatePath(CHANNELS, 'page');
    return { ok: true, approved: done.approved, skipped: done.skipped };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.bulk_approve_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause) && cause.kind === 'authorization')
      return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  }
}

export type RerunResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_settled' | 'forbidden' | 'failed' };

/** Runs the analysis again - it clears this report first. After the second press. */
export async function rerunAnalysis(importId: string): Promise<RerunResult> {
  try {
    await serverApi().post({
      endpoint: knowledgeEndpoints.rerun(importId),
      payload: z.unknown(),
      body: {},
      raw: true,
    });
    revalidatePath(CHANNELS, 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.rerun_failed', { status: isApiError(cause) ? cause.status : undefined });
    if (isApiError(cause)) {
      if (cause.status === 409) return { ok: false, reason: 'not_settled' };
      if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
