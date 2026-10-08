'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { campaignSchema } from '@/api/contracts/outreach';
import { outreachEndpoints, templateEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * The one write on screen 05, and it is destructive.
 *
 * ── THERE IS NO PAUSE ACTION, AND THERE WILL NOT BE ONE ──
 * `POST /:id/cancel` is the only thing that stops a send, and it is terminal:
 * it removes the queued jobs, marks every pending recipient `"skipped"` with
 * the reason *"Broadcast cancelled"*, sets `completedAt`, and leaves the
 * campaign `CANCELLED`. **No route returns it to `SENDING`.**
 *
 * Naming this `pauseCampaign` would be the failure this screen exists to
 * avoid: the word promises that it halts *and* that it resumes, and only the
 * first is true. The second is the half someone relies on when they stop a
 * campaign for ten minutes.
 *
 * So the function is called what it does, and the UI confirmation names what
 * is lost rather than asking whether the person is sure - "are you sure?"
 * tests conviction, not understanding.
 */

export type OutreachWriteResult =
  | { readonly ok: true }
  /**
   * The campaign is not in a state that can be stopped.
   *
   * The route accepts `SENDING` and `SCHEDULED` only and answers 400
   * otherwise. Its own outcome because it is a race rather than a fault: a
   * campaign that finished while the page was open is not an error, and the
   * remedy is to show what it actually is now.
   */
  | { readonly ok: false; readonly reason: 'not_stoppable' }
  | { readonly ok: false; readonly reason: 'forbidden' }
  | { readonly ok: false; readonly reason: 'failed' };

/**
 * Stops a campaign permanently. Not a pause.
 *
 * Everyone still queued is marked skipped and will not receive the message,
 * and the campaign cannot be restarted - only copied with `resend`.
 */
export async function stopCampaign(id: string): Promise<OutreachWriteResult> {
  try {
    await serverApi().post({
      endpoint: outreachEndpoints.cancel(id),
      payload: campaignSchema,
      body: {},
    });
    revalidatePath('/[locale]/(app)/outreach', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'not_stoppable' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    logger.warn('outreach.cancel_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

export type SendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'refused'; readonly why: string | null }
  /**
   * 422 MISSING_REMOVAL_LINE (Backend 6ba6fac2): a MARKETING template made
   * before the removal line ("Reply STOP to unsubscribe") was added on save.
   * Trying again cannot help; a copy gets the line.
   */
  | { readonly ok: false; readonly reason: 'removal_line' }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

const missingRemovalLine = (cause: unknown) =>
  isApiError(cause) && cause.status === 422 && cause.code === 'MISSING_REMOVAL_LINE';

/** Sends a DRAFT campaign - to real people, after the owner's second press. */
export async function sendCampaign(id: string): Promise<SendResult> {
  try {
    await serverApi().post({
      endpoint: outreachEndpoints.send(id),
      payload: z.unknown(),
      body: {},
      raw: true,
    });
    revalidatePath('/[locale]/(app)/outreach', 'layout');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('outreach.send_failed', { status: isApiError(cause) ? cause.status : undefined });
    if (missingRemovalLine(cause)) return { ok: false, reason: 'removal_line' };
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      // The route's own reason ("No recipients to send to…") is the platform's
      // words, kept for the title only - the sentence shown is ours.
      if (cause.status === 400)
        return { ok: false, reason: 'refused', why: cause.developerMessage ?? null };
    }
    return { ok: false, reason: 'failed' };
  }
}

/** Submits a DRAFT or REJECTED template to Meta for review. */
export async function submitTemplate(id: string): Promise<SendResult> {
  try {
    await serverApi().post({
      endpoint: templateEndpoints.submit(id),
      payload: z.unknown(),
      body: {},
      raw: true,
    });
    revalidatePath('/[locale]/(app)/outreach/templates', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('templates.submit_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (missingRemovalLine(cause)) return { ok: false, reason: 'removal_line' };
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 400)
        return { ok: false, reason: 'refused', why: cause.developerMessage ?? null };
    }
    return { ok: false, reason: 'failed' };
  }
}
