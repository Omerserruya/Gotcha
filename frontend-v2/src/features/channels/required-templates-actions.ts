'use server';

/**
 * The WhatsApp templates every number needs (Backend 7e91418b) - read, save,
 * and the one write that leaves the building.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ `submit: true` SENDS A TEMPLATE TO META FOR REVIEW. REAL, OUTWARD, NOT
 *   REVERSIBLE. NOTHING AUTOMATED MAY FIRE IT - NOT A TEST, NOT A CAPTURE.
 * ════════════════════════════════════════════════════════════════════════════
 * The screen sends it only from its own button, after its own confirm; a
 * Save is `submit: false` and stays a draft. Tests mock `serverApi`. On dev
 * the real submit is Omer's to press.
 *
 * `/api/templates/sync` (a read from Meta into our rows) is not called here.
 */

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  requiredTemplatesSchema,
  type RequiredRole,
  type RequiredTemplates,
} from '@/api/contracts/required-templates';
import { templateEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { loadWhatsAppNumbers } from './load-whatsapp';

export type RequiredRead =
  | { readonly ok: true; readonly data: RequiredTemplates }
  /** ADMIN (Owner) only: said in words, never as an empty list. */
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/** One number's required templates, each with its state. */
export async function loadRequiredTemplates(channelAccountId: string): Promise<RequiredRead> {
  try {
    const data = await serverApi().get({
      endpoint: templateEndpoints.required(),
      query: { channelAccountId },
      payload: requiredTemplatesSchema,
    });
    return { ok: true, data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    logger.warn('templates.required_read_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

export interface RequiredSave {
  readonly channelAccountId: string;
  readonly role: RequiredRole;
  readonly language: string;
  readonly body: string;
  /** The quick-reply button's text, as read; `null` for none. */
  readonly button: string | null;
  /** ★ true sends it to Meta. Only the screen's confirmed submit passes it. */
  readonly submit: boolean;
}

export type RequiredSaveResult =
  | { readonly ok: true; readonly submitted: boolean }
  | {
      readonly ok: false;
      readonly reason:
        /** 409 NUMBER_NOT_CONNECTED: saved as a draft, not sent. */
        | 'not_connected'
        /** 409 ALREADY_SUBMITTED: approved or pending; Outreach edits it. */
        | 'already_submitted'
        | 'forbidden'
        /** 400 from the submit: saved, and Meta (or its checks) refused it. */
        | 'refused'
        /** 400 BAD_BODY: 1-1024 characters. */
        | 'bad_body'
        /** 404 NUMBER_NOT_FOUND. */
        | 'not_found'
        | 'failed';
      /** ALREADY_SUBMITTED's row, to open in Outreach. */
      readonly templateId?: string | null;
    };

/**
 * The route answers `{ data: saved, submitted }` - `data` with a sibling, so
 * `raw`, or the client unwraps `data` and `submitted` is lost.
 */
const savedSchema = z.object({
  submitted: z.boolean().catch(false).default(false),
});

/** Save one required template; with `submit`, send it to Meta for review. */
export async function saveRequiredTemplate(input: RequiredSave): Promise<RequiredSaveResult> {
  try {
    const out = await serverApi().post({
      endpoint: templateEndpoints.required(),
      body: {
        channelAccountId: input.channelAccountId,
        role: input.role,
        language: input.language,
        body: input.body,
        button: input.button,
        submit: input.submit,
      },
      payload: savedSchema,
      raw: true,
    });
    return { ok: true, submitted: out.submitted };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('templates.required_save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
      code: isApiError(cause) ? cause.code : undefined,
      submit: input.submit,
    });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 409 && cause.code === 'NUMBER_NOT_CONNECTED')
        return { ok: false, reason: 'not_connected' };
      if (cause.status === 409 && cause.code === 'ALREADY_SUBMITTED') {
        const id = cause.errorData?.id;
        return {
          ok: false,
          reason: 'already_submitted',
          templateId: typeof id === 'string' ? id : null,
        };
      }
      if (cause.status === 400 && cause.code === 'BAD_BODY')
        return { ok: false, reason: 'bad_body' };
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
      if (cause.status === 400 || cause.status === 422) return { ok: false, reason: 'refused' };
    }
    return { ok: false, reason: 'failed' };
  }
}

const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

/**
 * Right after a connect: the number's channel account, and its required
 * templates. The connect route answers no channel account id, so it is found
 * on the numbers list - by Meta's phone number id where the list carries it
 * (an unprofiled number), else by the number's digits. `null` when it is not
 * there yet: the step then says where the templates wait.
 */
export async function requiredForConnected(
  phoneNumberId: string,
  phoneNumber: string | null,
): Promise<{ readonly channelAccountId: string; readonly read: RequiredRead } | null> {
  const numbers = await loadWhatsAppNumbers();
  if (!numbers) return null;
  const wanted = digits(phoneNumber);
  const channelAccountId =
    numbers.unprofiled.find((u) => u.phoneNumberId === phoneNumberId)?.channelAccountId ??
    (wanted
      ? numbers.data.find((n) => n.channelAccountId && digits(n.phoneNumber) === wanted)
          ?.channelAccountId
      : null) ??
    null;
  if (!channelAccountId) return null;
  return { channelAccountId, read: await loadRequiredTemplates(channelAccountId) };
}
