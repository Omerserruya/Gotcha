'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { GAP_ANSWER_MAX } from '@/api/contracts/knowledge';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type GapAnswer =
  | { readonly ok: true; readonly resolvedAt: string }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'too_long' | 'forbidden' | 'gone' | 'not_learned' | 'failed';
    };

/**
 * ⚠ THIS WRITES THE KNOWLEDGE EVERY AI EMPLOYEE ANSWERS FROM. 08's Answer:
 * the owner's words, sent exactly as typed, become what GOTCHA says when
 * this is asked again - and the question leaves the open list. Omer approved
 * adding knowledge (08b); this is the same write from the gap's door. No
 * test or capture presses it on dev.
 *
 * It waits while the answer is learned (a second or two). 502 NOT_LEARNED:
 * saved but not learned - the question stays open, and nothing is said to
 * be answered.
 */
export async function answerGap(id: string, answer: string): Promise<GapAnswer> {
  if (answer.trim() === '') return { ok: false, reason: 'empty' };
  if (answer.length > GAP_ANSWER_MAX) return { ok: false, reason: 'too_long' };
  try {
    const done = await serverApi().post({
      endpoint: knowledgeEndpoints.answerUnanswered(id),
      body: { answer },
      payload: z.object({ resolvedAt: z.string() }),
    });
    revalidatePath('/[locale]/studio/knowledge', 'page');
    return { ok: true, resolvedAt: done.resolvedAt };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.code === 'NOT_LEARNED') return { ok: false, reason: 'not_learned' };
      if (cause.code === 'ANSWER_REQUIRED') return { ok: false, reason: 'empty' };
      if (cause.code === 'ANSWER_TOO_LONG') return { ok: false, reason: 'too_long' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    logger.warn('knowledge.gap_answer_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
