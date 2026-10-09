'use server';

import { getLocale } from 'next-intl/server';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { featureRefusalFrom } from '@/api/client/tenant-gate';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { activityResponseSchema, type ActivityStep } from '@/api/contracts/ai-activity';
import { suggestionsResponseSchema } from '@/api/contracts/copilot';
import { messageSchema, type InboxMessage } from '@/api/contracts/inbox';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { loadCopilot, type CopilotRead } from '../load-copilot';

/**
 * The stored suggestions - once when the wall opens on a conversation, and
 * again on `copilot.suggestions.updated`. Never on a render, never on a
 * timer. Since Backend 9c5e96cc the GET reads a store and runs no model.
 * `loadCopilot` never throws: it returns which kind of nothing it got.
 */
export async function readSuggestions(conversationId: string): Promise<CopilotRead> {
  return loadCopilot(conversationId);
}

/**
 * The AI's steps here - once when the wall opens; after that each
 * `ai.activity.updated` changes its row in place. `null`: unread.
 */
export async function readActivity(
  conversationId: string,
): Promise<readonly ActivityStep[] | null> {
  try {
    const answer = await serverApi().get({
      endpoint: inboxEndpoints.aiActivity(conversationId),
      query: { limit: 20 },
      payload: activityResponseSchema,
      raw: true,
    });
    return answer.data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('inbox.wall_activity_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

export type RefreshRead =
  | CopilotRead
  /** 15s per conversation, 20 per agent per 10 min. `null`: the route named no wait. */
  | { readonly state: 'rate_limited'; readonly retryAfterSeconds: number | null };

/**
 * "Try again" - a model call, metered. Only the button calls this; nothing
 * calls it on its own, ever.
 */
export async function refreshSuggestions(conversationId: string): Promise<RefreshRead> {
  try {
    const response = await serverApi().post({
      endpoint: inboxEndpoints.suggestionsRefresh(conversationId),
      body: { locale: await getLocale() },
      payload: suggestionsResponseSchema,
      // `data` beside `copilotMode`: see `loadCopilot`.
      raw: true,
      timeoutMs: 60_000,
    });
    return { state: 'ok', response };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 429) {
      return { state: 'rate_limited', retryAfterSeconds: cause.retryAfterSeconds ?? null };
    }
    const refusal = featureRefusalFrom(cause);
    if (refusal) return { state: 'refused', refusal };
    logger.warn('inbox.copilot_refresh_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { state: 'unavailable' };
  }
}

// Strict, as the stream's own: a page that does not parse is a failed read, not an empty one.
const pageSchema = z.object({ data: z.array(messageSchema) });

/** History, level 3: the whole conversation, to read - never to answer from here. */
export async function conversationMessages(
  conversationId: string,
): Promise<
  { readonly ok: true; readonly messages: readonly InboxMessage[] } | { readonly ok: false }
> {
  try {
    const page = await serverApi().get({
      endpoint: inboxEndpoints.messages(conversationId),
      payload: pageSchema,
      raw: true,
    });
    return { ok: true, messages: page.data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('inbox.wall_messages_failed', { cause });
    return { ok: false };
  }
}
