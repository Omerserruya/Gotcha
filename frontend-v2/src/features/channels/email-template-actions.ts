'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  EMAIL_TEMPLATE_ERRORS,
  emailTemplateTestSchema,
  savedEmailTemplateSchema,
  type EmailTemplate,
  type RemovedKind,
} from '@/api/contracts/email-template';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type SaveTemplateRefusal =
  'content_missing' | 'too_large' | 'not_set' | 'forbidden' | 'not_found' | 'failed';

export type SaveTemplateResult =
  | {
      readonly ok: true;
      readonly template: EmailTemplate;
      /** What the server's sanitiser took out of the html that was sent. */
      readonly removed: readonly RemovedKind[];
    }
  | { readonly ok: false; readonly reason: SaveTemplateRefusal };

/**
 * PUT the template. `html` omitted keeps the stored one, so the on/off
 * toggle sends `{ enabled }` alone and never re-sends (or loses) the html.
 */
export async function saveEmailTemplate(
  id: string,
  body: { readonly enabled: boolean; readonly html?: string },
): Promise<SaveTemplateResult> {
  try {
    const { removed, ...template } = await serverApi().put({
      endpoint: channelEndpoints.emailTemplate(id),
      payload: savedEmailTemplateSchema,
      body: body.html === undefined ? { enabled: body.enabled } : body,
    });
    revalidatePath('/[locale]/settings/channels', 'page');
    return { ok: true, template, removed };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const status = isApiError(cause) ? cause.status : undefined;
    const error = isApiError(cause) ? cause.developerMessage : undefined;
    logger.warn('channels.email_template_save_failed', { status, error });
    if (error === EMAIL_TEMPLATE_ERRORS.contentMissing)
      return { ok: false, reason: 'content_missing' };
    if (error === EMAIL_TEMPLATE_ERRORS.tooLarge) return { ok: false, reason: 'too_large' };
    if (error === EMAIL_TEMPLATE_ERRORS.notSet) return { ok: false, reason: 'not_set' };
    if (status === 403) return { ok: false, reason: 'forbidden' };
    if (status === 404) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'failed' };
  }
}

export type TestSendResult =
  | { readonly ok: true; readonly sentTo: string }
  | {
      readonly ok: false;
      readonly reason:
        'not_set' | 'no_sender' | 'not_connected' | 'send_failed' | 'forbidden' | 'failed';
      /** The provider's own words, on `send_failed` only. */
      readonly detail?: string;
    };

/**
 * POST the test. No body and no recipient, by design: the server sends the
 * STORED template, through this mailbox, to the signed-in user's own address.
 * A real send - every test of this screen mocks it.
 */
export async function sendEmailTemplateTest(id: string): Promise<TestSendResult> {
  try {
    const { sentTo } = await serverApi().post({
      endpoint: channelEndpoints.emailTemplateTest(id),
      payload: emailTemplateTestSchema,
    });
    return { ok: true, sentTo };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const status = isApiError(cause) ? cause.status : undefined;
    const error = isApiError(cause) ? cause.developerMessage : undefined;
    logger.warn('channels.email_template_test_failed', { status, error });
    if (error === EMAIL_TEMPLATE_ERRORS.notSet) return { ok: false, reason: 'not_set' };
    if (error === EMAIL_TEMPLATE_ERRORS.noSender) return { ok: false, reason: 'no_sender' };
    if (error === EMAIL_TEMPLATE_ERRORS.notConnected) return { ok: false, reason: 'not_connected' };
    if (error === EMAIL_TEMPLATE_ERRORS.sendFailed) {
      const detail = isApiError(cause) ? cause.detailText : undefined;
      return { ok: false, reason: 'send_failed', ...(detail ? { detail } : {}) };
    }
    if (status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  }
}
