'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { COMPOSE_KINDS, type ComposeKind } from './compose-kinds';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * 02's three composer chips — Rewrite · Shorter · Translate.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NOTHING HERE SENDS. THE TEXT COMES BACK INTO THE BOX.
 * ════════════════════════════════════════════════════════════════════════════
 * `POST /api/ai-assist/compose` drafts text and returns it. The composer puts
 * it in place of the draft, where the person reads it and presses Send — or
 * does not. Send stays the one control that reaches the customer.
 *
 * ── THE ROUTE TAKES AN INSTRUCTION, NOT A MODE ──
 * There are no typed modes on the platform, so the three instructions are
 * written here, once. The client sends WHICH chip, never the words: a server
 * action is a public endpoint, and accepting free text would make this a
 * general-purpose prompt relay billed to the tenant.
 *
 * ⚠ `locale` IS NOT SENT. It makes the route write in that language, which
 *   would turn "Shorter" into a translation for anyone whose interface is in
 *   the other one. Each instruction says which language to write in instead.
 */

const INSTRUCTIONS: Record<ComposeKind, string> = {
  rewrite:
    'Rewrite the current draft so it reads clearly and warmly. Keep its meaning, every fact in it, and its language.',
  shorter:
    'Make the current draft shorter. Keep every fact and commitment in it, and keep its language.',
  /*
   * ★ "The customer's language", which the route can see: with a conversation
   *   it reads the last twenty messages into the prompt.
   */
  translate:
    'Translate the current draft into the language the customer is writing in. Change nothing else.',
};

const composed = z.object({ text: z.string() });

export type ComposeResult =
  | { readonly ok: true; readonly text: string }
  /** Nothing to work on: the three chips all act on a draft. */
  | { readonly ok: false; readonly reason: 'empty' }
  /** The model answered with nothing. Not the same as a failure, said apart. */
  | { readonly ok: false; readonly reason: 'blank' }
  /**
   * ★★ THE WORKSPACE HAS RUN OUT OF AI UNITS. Not "just now" and not "our
   *   side": it lasts until somebody tops up, and that is in the workspace's
   *   hands. The route answers 500 for it, but its body carries the error's
   *   message, which `AiUnitsExhaustedError` builds as `ai_units:${reason}` —
   *   a prefix from a class, not prose.
   */
  | { readonly ok: false; readonly reason: 'units_exhausted' }
  | { readonly ok: false; readonly reason: 'failed' };

export async function composeDraft(
  conversationId: string,
  kind: ComposeKind,
  draft: string,
): Promise<ComposeResult> {
  if (!COMPOSE_KINDS.includes(kind)) return { ok: false, reason: 'failed' };
  const currentDraft = draft.trim();
  if (currentDraft === '') return { ok: false, reason: 'empty' };

  try {
    const { text } = await serverApi().post({
      endpoint: inboxEndpoints.compose(),
      payload: composed,
      body: { instruction: INSTRUCTIONS[kind], surface: 'inbox', conversationId, currentDraft },
      // A model call, not a lookup.
      timeoutMs: 60_000,
    });
    return text.trim() === '' ? { ok: false, reason: 'blank' } : { ok: true, text: text.trim() };
  } catch (cause) {
    await signInIfSignedOut(cause);
    // The draft is somebody's words to a customer: never logged.
    logger.warn('inbox.compose_failed', {
      kind,
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause) && cause.developerMessage?.startsWith('ai_units:')) {
      return { ok: false, reason: 'units_exhausted' };
    }
    return { ok: false, reason: 'failed' };
  }
}

/**
 * The wall's "Ask Copilot anything": the agent's own words as the instruction,
 * with this conversation. The route drafts ONE outbound message —
 * it answers questions by writing the reply — and nothing is sent: the text
 * goes into the composer for a person to read.
 */
export async function askCopilot(
  conversationId: string,
  instruction: string,
): Promise<ComposeResult> {
  const asked = instruction.trim();
  if (asked === '') return { ok: false, reason: 'empty' };
  try {
    const { text } = await serverApi().post({
      endpoint: inboxEndpoints.compose(),
      payload: composed,
      body: {
        instruction: asked.slice(0, 1000),
        surface: 'inbox',
        conversationId,
      },
      timeoutMs: 60_000,
    });
    return text.trim() === '' ? { ok: false, reason: 'blank' } : { ok: true, text: text.trim() };
  } catch (cause) {
    await signInIfSignedOut(cause);
    // An agent's words about a customer: never logged.
    logger.warn('inbox.ask_failed', {
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause) && cause.developerMessage?.startsWith('ai_units:')) {
      return { ok: false, reason: 'units_exhausted' };
    }
    return { ok: false, reason: 'failed' };
  }
}
