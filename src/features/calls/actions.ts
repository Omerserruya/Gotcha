'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { callEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * 05d / 05e — placing, ending and transferring a call (Omer, 2026-10-04).
 *
 * The same writes the old frontend makes. Each is a real phone call on a
 * real line: nothing here runs except from a click, and the tests assert so.
 */

export type CallWriteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `invalid_destination`: not a number the server accepts (E.164).
       * `no_active_voice_channel`: the business has no voice line.
       * `agent_phone_not_configured` / `caller_id_not_configured`: the
       *   line's own setup, named by the server.
       * `forbidden`, `gone`, `failed`: as everywhere.
       */
      readonly reason: string;
    };

const PATH = '/[locale]/(app)/outreach/calls';

function reasonOf(cause: unknown): string {
  if (isApiError(cause)) {
    if (cause.status === 403) return 'forbidden';
    if (cause.status === 404) return 'gone';
    /*
      The route answers `{ error: "invalid_destination" }`, which the client
      puts in `developerMessage` (see `ApiError.code`'s note).
    */
    const code = cause.developerMessage;
    if (typeof code === 'string' && /^[a-z_]+$/.test(code)) return code;
  }
  return 'failed';
}

const startSchema = z.object({
  mode: z.enum(['IN_PLATFORM', 'AGENT_FIRST']).catch('IN_PLATFORM'),
  sessionId: z.string().nullable().catch(null).default(null),
});

export type StartCallResult =
  /** The server rings the line's agent, then bridges the customer. */
  | { readonly ok: true; readonly mode: 'AGENT_FIRST'; readonly sessionId: string | null }
  /**
   * The line dials from a browser phone, which this app does not have. The
   * route creates nothing in this mode — nothing was dialled.
   */
  | { readonly ok: true; readonly mode: 'IN_PLATFORM' }
  | Extract<CallWriteResult, { ok: false }>;

export async function startCall(to: string, conversationId?: string): Promise<StartCallResult> {
  try {
    const result = await serverApi().post({
      endpoint: callEndpoints.startOutbound(),
      payload: startSchema,
      body: { to, ...(conversationId ? { conversationId } : {}) },
    });
    if (result.mode === 'IN_PLATFORM') return { ok: true, mode: 'IN_PLATFORM' };
    revalidatePath(PATH, 'page');
    return { ok: true, mode: 'AGENT_FIRST', sessionId: result.sessionId };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('calls.start_failed', { cause });
    return { ok: false, reason: reasonOf(cause) };
  }
}

async function post(
  endpoint: ReturnType<(typeof callEndpoints)['hangup']>,
  body: Record<string, unknown> | undefined,
  event: string,
): Promise<CallWriteResult> {
  try {
    await serverApi().post({ endpoint, payload: z.unknown(), body: body ?? {}, raw: true });
    revalidatePath(PATH, 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn(event, { cause });
    return { ok: false, reason: reasonOf(cause) };
  }
}

export async function endCall(sessionId: string): Promise<CallWriteResult> {
  return post(callEndpoints.hangup(sessionId), undefined, 'calls.hangup_failed');
}

export async function addToCall(sessionId: string, to: string): Promise<CallWriteResult> {
  return post(callEndpoints.addParticipant(sessionId), { to }, 'calls.add_failed');
}

export async function holdCustomer(sessionId: string, hold: boolean): Promise<CallWriteResult> {
  return post(callEndpoints.customerHold(sessionId), { hold }, 'calls.hold_failed');
}

export async function leaveCall(sessionId: string): Promise<CallWriteResult> {
  return post(callEndpoints.agentLeave(sessionId), undefined, 'calls.leave_failed');
}
