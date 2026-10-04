'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Sending a reply.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THIS IS THE ONE CONTROL IN THIS PROJECT WHOSE PURPOSE IS TO BE PRESSED
 * ════════════════════════════════════════════════════════════════════════════
 * Every other write here is something somebody *might* press — sign out
 * everywhere, resolve a conflict, connect a system — and the rule has been that
 * no test and no capture presses it. That rule holds and is not enough on its
 * own, because a composer is a thing somebody **will** press, by design, and on
 * the dev tenant the first person to press it is one of us during a walk.
 *
 * Dev's WhatsApp channel reaches real handsets. A message sent from a walk is
 * not a test artefact; it is a message a person receives from GOTCHA, and this
 * platform has no undo anywhere.
 *
 * So: no automated run calls this — `Composer.test.tsx` mocks it to throw — and
 * **no human presses the control on dev until Omer has said so in his own
 * words.** Built and unpressed is a real state and this is it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A 201 IS A CLAIM ABOUT OUR DATABASE, NOT ABOUT A CUSTOMER'S PHONE
 * ════════════════════════════════════════════════════════════════════════════
 * The route validates, writes a `Message` row, and enqueues onto
 * `outgoingMessageQueue`. Delivery happens later and asynchronously through a
 * path the response cannot see, so **nothing here may say "sent".** `queued` is
 * the strongest true word, and the row's own `status` — `PENDING` → `SENT` →
 * `DELIVERED`, or `FAILED` — is what reports the rest, on the stream.
 *
 * That is also why `Message.status` had to reach the contract first: a composer
 * over a stream that cannot report `FAILED` is a screen that lies in exactly the
 * case that matters, and the operator, told it worked, stops watching.
 */

/** Nothing reads the created row: `revalidatePath` re-reads the stream. */
const unchecked = z.unknown();

export type SendResult =
  /** Queued. NOT delivered — see the note above. */
  | { readonly ok: true }
  /** `body` was empty. The route answers 400 and the control also prevents it. */
  | { readonly ok: false; readonly reason: 'empty' }
  /** 404 — the conversation is not there, or not visible to this tenant. */
  | { readonly ok: false; readonly reason: 'not_found' }
  /**
   * 400 `Channel not configured for this tenant`.
   *
   * A real and recoverable state: the conversation arrived on a channel whose
   * credentials have since been removed. Worth its own sentence, because
   * "try again" is the wrong advice and nothing about the message is at fault.
   */
  | { readonly ok: false; readonly reason: 'channel_not_configured' }
  /** 400 — the quoted message is not in this conversation. */
  | { readonly ok: false; readonly reason: 'quote_not_here' }
  | { readonly ok: false; readonly reason: 'failed' };

/**
 * Enqueue a reply on the conversation's own channel.
 *
 * `emailReplyMode` is deliberately not passed. The route defaults to `reply`,
 * which continues the customer's existing mail thread, and its own comment says
 * that is the behaviour an agent answering an email expects. Offering the choice
 * is a control nobody has asked for; **defaulting to it is the correct behaviour
 * and passing nothing is how we get it.**
 */
export async function sendReply(
  conversationId: string,
  body: string,
  /**
   * The message this answers — 02's Reply. The route checks it belongs to
   * this conversation and quotes it on the customer's channel.
   */
  replyToMessageId?: string,
): Promise<SendResult> {
  const text = body.trim();
  /*
   * Checked here as well as on the route. The route answers 400 for an empty
   * body, and a round trip to be told what we already knew is a worse
   * experience than a disabled button — but the guard is here rather than only
   * in the component because a server action is a public endpoint.
   */
  if (text === '') return { ok: false, reason: 'empty' };

  try {
    await serverApi().post({
      endpoint: inboxEndpoints.sendMessage(conversationId),
      payload: unchecked,
      body: replyToMessageId ? { body: text, replyToMessageId } : { body: text },
    });
    revalidatePath('/[locale]/(app)/inbox', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    /*
     * ⚠ NOTHING IN THIS LOG IS THE MESSAGE. A failed send is exactly when
     * somebody is tempted to log the body to work out what happened, and the
     * body is a person's own words to a business. The cause carries a status and
     * a route and no customer data.
     */
    logger.warn('inbox.send_failed', { cause, conversationId });

    if (!isApiError(cause)) return { ok: false, reason: 'failed' };
    if (cause.status === 404) return { ok: false, reason: 'not_found' };
    /*
     * ★★ TWO 400s WITH DIFFERENT MEANINGS AND NO `code` ON EITHER.
     *
     * The route answers `{ error: "Channel not configured for this tenant" }`
     * and `{ error: "The message you are replying to is not in this
     * conversation" }`. Neither sends a `code`, so the house idiom — matching
     * `cause.code` — compiles here and can never fire. The reason lands in
     * `developerMessage`, and that is what has to be read.
     *
     * Matched on a narrow, stable substring rather than the whole sentence: the
     * wording is prose in a route nobody promised to keep, and a match on the
     * full sentence breaks on a full stop.
     */
    if (cause.status === 400) {
      const said = cause.developerMessage?.toLowerCase() ?? '';
      if (said.includes('channel not configured')) {
        return { ok: false, reason: 'channel_not_configured' };
      }
      if (said.includes('replying to')) return { ok: false, reason: 'quote_not_here' };
    }
    return { ok: false, reason: 'failed' };
  }
}
