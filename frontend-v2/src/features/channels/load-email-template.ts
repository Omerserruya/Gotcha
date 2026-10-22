import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { emailTemplateSchema, type EmailTemplate } from '@/api/contracts/email-template';
import { currentUserSchema } from '@/api/contracts/identity';
import { authEndpoints, channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * One mailbox's template, for its panel.
 *
 * A failed read is NOT an empty template: "never saved" would offer a blank
 * editor whose save replaces a template that exists. So the editor is drawn
 * only from a read that succeeded.
 */
export type EmailTemplateRead =
  | { readonly state: 'ok'; readonly template: EmailTemplate }
  | { readonly state: 'not_found' | 'forbidden' | 'failed' };

export async function loadEmailTemplate(id: string): Promise<EmailTemplateRead> {
  try {
    const template = await serverApi().get({
      endpoint: channelEndpoints.emailTemplate(id),
      payload: emailTemplateSchema,
    });
    return { state: 'ok', template };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const status = isApiError(cause) ? cause.status : undefined;
    logger.warn('channels.email_template_read_failed', { status });
    // Not this workspace's, or not an email account: either way, no such mailbox here.
    if (status === 404) return { state: 'not_found' };
    if (status === 403) return { state: 'forbidden' };
    return { state: 'failed' };
  }
}

/**
 * The preview's real values: the signed-in person (who a test is from) and
 * the workspace (`/api/auth/me` names both). `null` when unread or unnamed -
 * the preview then draws the placeholder itself, never an invented name.
 */
export async function loadPreviewNames(): Promise<{
  readonly agent: string | null;
  readonly business: string | null;
}> {
  try {
    const me = await serverApi().get({ endpoint: authEndpoints.me(), payload: currentUserSchema });
    return { agent: me.user.name?.trim() || null, business: me.tenantName?.trim() || null };
  } catch (cause) {
    logger.warn('channels.email_template_me_failed', { cause });
    return { agent: null, business: null };
  }
}
