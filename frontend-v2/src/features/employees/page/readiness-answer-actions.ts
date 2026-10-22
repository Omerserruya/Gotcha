'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { employeeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { MAX_READINESS_ANSWER } from './readiness';

export type ReadinessAnswerResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'forbidden' | 'missing' | 'stale' | 'not_learned' | 'too_long' | 'failed';
    };

/**
 * ★★ E2 (Omer, 2026-10-14): a question the employee is not ready for,
 * answered by a person - the answer is written into the workspace's
 * knowledge (Backend 201ad16a) and the next run counts the question covered.
 *
 * By its stable id where the report has one (B6), else by its words. The
 * route awaits the answer being learned: one that was saved but not learned
 * (502 NOT_LEARNED) leaves the question open, and says so.
 *
 * ⚠ It writes REAL knowledge on the tenant: tests mock it, never dev.
 */
export async function answerReadinessQuestion(
  employeeId: string,
  question: { readonly id: string | null; readonly question: string },
  answer: string,
): Promise<ReadinessAnswerResult> {
  const words = answer.trim();
  if (!employeeId || !words || !question.question.trim()) return { ok: false, reason: 'failed' };
  if (words.length > MAX_READINESS_ANSWER) return { ok: false, reason: 'too_long' };
  try {
    await serverApi().post({
      endpoint: employeeEndpoints.readinessAnswer(employeeId),
      body: {
        ...(question.id ? { questionId: question.id } : { question: question.question }),
        answer: words,
      },
      payload: z.unknown(),
      // It is learned (embedded) before the route answers.
      timeoutMs: 60_000,
    });
    revalidatePath('/[locale]/studio/employees', 'layout');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('employees.readiness_answer_failed', {
      status: isApiError(cause) ? cause.status : undefined,
      code: isApiError(cause) ? cause.code : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.code === 'QUESTION_NOT_FOUND') return { ok: false, reason: 'stale' };
      if (cause.status === 404) return { ok: false, reason: 'missing' };
      if (cause.code === 'NOT_LEARNED') return { ok: false, reason: 'not_learned' };
      if (cause.code === 'ANSWER_TOO_LONG') return { ok: false, reason: 'too_long' };
    }
    return { ok: false, reason: 'failed' };
  }
}
