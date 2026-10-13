'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { replyTemplateListSchema, type ReplyTemplate } from '@/api/contracts/inbox';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Templates in a conversation (Backend 47e376a4): past WhatsApp's 24 hours
 * only an approved template may go out, and it is what reopens the window
 * when the customer answers.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ `sendTemplate` SENDS A REAL WHATSAPP MESSAGE TO A REAL PERSON
 * ════════════════════════════════════════════════════════════════════════════
 * Like `sendReply`: no automated run calls it - the tests mock this module -
 * and a 201 means QUEUED, never delivered.
 */

export type TemplateListResult =
  { readonly ok: true; readonly templates: readonly ReplyTemplate[] } | { readonly ok: false };

export async function loadReplyTemplates(conversationId: string): Promise<TemplateListResult> {
  try {
    const templates = await serverApi().get({
      endpoint: inboxEndpoints.replyTemplates(conversationId),
      payload: replyTemplateListSchema,
    });
    return { ok: true, templates };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('inbox.reply_templates_failed', {
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false };
  }
}

export type TemplateSendResult =
  /** Queued. NOT delivered. */
  | { readonly ok: true }
  /** A variable was left blank: the route would send its sample, or "-". */
  | { readonly ok: false; readonly reason: 'blank' }
  /** 409 `TEMPLATE_NOT_USABLE` - not approved for this number (any more). */
  | { readonly ok: false; readonly reason: 'not_usable' }
  /** 400 `TEMPLATES_WHATSAPP_ONLY`. */
  | { readonly ok: false; readonly reason: 'whatsapp_only' }
  | { readonly ok: false; readonly reason: 'channel_not_configured' }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'failed' };

/** Nothing reads the created row: `revalidatePath` re-reads the stream. */
const unchecked = z.unknown();

export async function sendTemplate(
  conversationId: string,
  templateId: string,
  variables: Readonly<Record<string, string>>,
): Promise<TemplateSendResult> {
  const values = Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, value.trim()]),
  );
  // A server action is a public endpoint: the composer's guard is repeated here.
  if (Object.values(values).some((value) => value === '')) return { ok: false, reason: 'blank' };

  try {
    await serverApi().post({
      endpoint: inboxEndpoints.sendTemplate(conversationId),
      payload: unchecked,
      body: { templateId, variables: values },
      raw: true,
    });
    revalidatePath('/[locale]/(app)/inbox', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    // Never the variables: they are words to a customer.
    logger.warn('inbox.template_send_failed', {
      conversationId,
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (!isApiError(cause)) return { ok: false, reason: 'failed' };
    if (cause.status === 404) return { ok: false, reason: 'not_found' };
    if (cause.code === 'TEMPLATE_NOT_USABLE') return { ok: false, reason: 'not_usable' };
    if (cause.code === 'TEMPLATES_WHATSAPP_ONLY') return { ok: false, reason: 'whatsapp_only' };
    if (
      cause.status === 400 &&
      (cause.developerMessage?.toLowerCase() ?? '').includes('channel not configured')
    ) {
      return { ok: false, reason: 'channel_not_configured' };
    }
    return { ok: false, reason: 'failed' };
  }
}
