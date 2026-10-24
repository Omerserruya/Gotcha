'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { featureRefusalFrom } from '@/api/client/tenant-gate';
import {
  COPILOT_MESSAGE_MAX,
  copilotChatAnswerSchema,
  copilotThreadSchema,
  type CopilotTurn,
} from '@/api/contracts/copilot-chat';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** Why the thread could not be read or changed. */
export type CopilotChatRefusal = 'not_on_plan' | 'failed';

export type CopilotThreadRead =
  | { readonly ok: true; readonly turns: readonly CopilotTurn[] }
  | { readonly ok: false; readonly reason: CopilotChatRefusal };

/** The agent's own thread about this conversation. An agent's words about a customer are never logged. */
export async function readCopilotChat(conversationId: string): Promise<CopilotThreadRead> {
  try {
    const { turns } = await serverApi().get({
      endpoint: inboxEndpoints.copilotChat(conversationId),
      payload: copilotThreadSchema,
    });
    return { ok: true, turns };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (featureRefusalFrom(cause)) return { ok: false, reason: 'not_on_plan' };
    logger.warn('inbox.copilot_chat_read_failed', {
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

export type CopilotAsk =
  | { readonly ok: true; readonly turns: readonly CopilotTurn[] }
  | {
      readonly ok: false;
      readonly reason:
        | CopilotChatRefusal
        | 'empty'
        | 'too_long'
        /** A round of this agent's is still running: keep the message, try again. */
        | 'busy'
        | 'no_ai_employee';
    };

/**
 * One exchange: the agent's message and the Copilot's answer, stored by the
 * server; the whole thread comes back. A failed round stores nothing.
 */
export async function askCopilotChat(
  conversationId: string,
  message: string,
  locale: string,
): Promise<CopilotAsk> {
  const asked = message.trim();
  if (asked === '') return { ok: false, reason: 'empty' };
  if (asked.length > COPILOT_MESSAGE_MAX) return { ok: false, reason: 'too_long' };
  try {
    const { turns } = await serverApi().post({
      endpoint: inboxEndpoints.copilotChat(conversationId),
      body: { message: asked, locale },
      payload: copilotChatAnswerSchema,
      // Up to three model calls (Backend: 3 to 15s).
      timeoutMs: 60_000,
    });
    return { ok: true, turns };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (featureRefusalFrom(cause)) return { ok: false, reason: 'not_on_plan' };
    const code = isApiError(cause) ? cause.code : undefined;
    logger.warn('inbox.copilot_chat_failed', {
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
      code,
    });
    if (code === 'COPILOT_CHAT_BUSY') return { ok: false, reason: 'busy' };
    if (code === 'MESSAGE_REQUIRED') return { ok: false, reason: 'empty' };
    if (code === 'MESSAGE_TOO_LONG') return { ok: false, reason: 'too_long' };
    if (code === 'NO_AI_EMPLOYEE') return { ok: false, reason: 'no_ai_employee' };
    return { ok: false, reason: 'failed' };
  }
}

/** "Start over": the agent's thread about this conversation, emptied. */
export async function clearCopilotChat(conversationId: string): Promise<CopilotThreadRead> {
  try {
    await serverApi().delete({
      endpoint: inboxEndpoints.copilotChat(conversationId),
      payload: copilotChatAnswerSchema,
    });
    return { ok: true, turns: [] };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (featureRefusalFrom(cause)) return { ok: false, reason: 'not_on_plan' };
    logger.warn('inbox.copilot_chat_clear_failed', {
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
