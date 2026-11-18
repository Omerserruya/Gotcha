'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { answerTooLong } from '@/api/contracts/knowledge-candidates';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

const CHANNELS = '/[locale]/(app)/settings/channels';
const KNOWLEDGE = '/[locale]/(app)/studio/knowledge';

/** Why a topic's approve or reject did not happen at all. */
export type TopicRefusal =
  /** 400 UNRESOLVED_ITEM: an item still needs its answer chosen. */
  | 'unresolved'
  /** 400 ANSWER_TOO_LONG, or refused here before sending. */
  | 'too_long'
  /** 404 TOPIC_NOT_FOUND: a rerun replaced the topics; the screen re-reads. */
  | 'stale'
  /** 403: `ai:knowledge:write` or ADMIN. */
  | 'forbidden'
  | 'failed';

export type ApproveTopicResult =
  | {
      readonly ok: true;
      /** Items the server approved. */
      readonly approved: readonly string[];
      /** Items it could not: the card stays pending with these marked. */
      readonly failed: readonly string[];
    }
  | { readonly ok: false; readonly reason: TopicRefusal };

export type RejectTopicResult =
  | { readonly ok: true; readonly documentsRemoved: number }
  | { readonly ok: false; readonly reason: TopicRefusal };

const approveResponse = z.object({
  results: z
    .array(
      z.object({
        candidateId: z.string(),
        ok: z.boolean().catch(false),
      }),
    )
    .catch([])
    .default([]),
});

const rejectResponse = z.object({
  documentsRemoved: z.number().catch(0).default(0),
});

/*
 * The route's codes: `error` (→ developerMessage) or `code`, whichever the
 * service sends; both are read so neither is a dead match.
 */
function refusalOf(cause: unknown): TopicRefusal {
  if (!isApiError(cause)) return 'failed';
  const codes = [cause.code, cause.developerMessage];
  if (cause.kind === 'authorization' || cause.status === 403) return 'forbidden';
  if (cause.status === 404 || codes.includes('TOPIC_NOT_FOUND')) return 'stale';
  if (codes.includes('UNRESOLVED_ITEM')) return 'unresolved';
  if (codes.includes('ANSWER_TOO_LONG')) return 'too_long';
  return 'failed';
}

/**
 * "אישור הנושא": every pending item of the topic, in one action. `items`
 * carries only the answers the reviewer chose or typed (see `itemAnswer`).
 */
export async function approveTopic(
  importId: string,
  topicId: string,
  items: readonly { readonly candidateId: string; readonly answer: string }[],
): Promise<ApproveTopicResult> {
  if (items.some((item) => answerTooLong(item.answer))) {
    logger.warn('channels.topic_answer_too_long', { topicId });
    return { ok: false, reason: 'too_long' };
  }
  try {
    const done = await serverApi().post({
      endpoint: knowledgeEndpoints.approveTopic(),
      payload: approveResponse,
      body: {
        importId,
        topicId,
        ...(items.length > 0
          ? { items: items.map((i) => ({ candidateId: i.candidateId, answer: i.answer.trim() })) }
          : {}),
      },
      raw: true,
    });
    revalidatePath(CHANNELS, 'page');
    revalidatePath(KNOWLEDGE, 'page');
    return {
      ok: true,
      approved: done.results.filter((r) => r.ok).map((r) => r.candidateId),
      failed: done.results.filter((r) => !r.ok).map((r) => r.candidateId),
    };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const reason = refusalOf(cause);
    logger.warn('channels.topic_approve_failed', {
      topicId,
      reason,
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason };
  }
}

/** "דחיית הנושא", and "ביטול" of an automatic approval (it removes those documents). */
export async function rejectTopic(importId: string, topicId: string): Promise<RejectTopicResult> {
  try {
    const done = await serverApi().post({
      endpoint: knowledgeEndpoints.rejectTopic(),
      payload: rejectResponse,
      body: { importId, topicId },
      raw: true,
    });
    revalidatePath(CHANNELS, 'page');
    revalidatePath(KNOWLEDGE, 'page');
    return { ok: true, documentsRemoved: done.documentsRemoved };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const reason = refusalOf(cause);
    logger.warn('channels.topic_reject_failed', {
      topicId,
      reason,
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason };
  }
}
