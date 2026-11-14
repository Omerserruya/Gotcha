'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  CONFIRM_REFUSALS,
  deletionConfirmedSchema,
  deletionRequestedSchema,
  isEmailLike,
  MAX_WORKSPACE,
  REQUEST_REFUSALS,
  type ConfirmRefusal,
  type DeletionConfirmed,
  type RequestRefusal,
} from '@/api/contracts/account-deletion';
import { accountDeletionEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The public account-deletion request and its confirm (Backend-Team's auth
 * routes, no session). Nothing here logs the address, the workspace or the
 * token.
 */
export type DeletionRequest =
  { readonly ok: true } | { readonly ok: false; readonly reason: RequestRefusal | 'failed' };

export type DeletionConfirm =
  | { readonly ok: true; readonly confirmed: DeletionConfirmed }
  | { readonly ok: false; readonly reason: ConfirmRefusal | 'failed' };

const codeOf = <T extends string>(cause: unknown, known: readonly T[]): T | null => {
  if (!isApiError(cause)) return null;
  const code = cause.developerMessage;
  if (code && (known as readonly string[]).includes(code)) return code as T;
  return null;
};

/**
 * Ask for the confirmation email. ★ Whether an account uses the address is
 * never answered here: the route says 202 for any well-formed one.
 */
export async function requestAccountDeletion(input: {
  readonly email: string;
  readonly workspace: string;
  readonly locale: string;
}): Promise<DeletionRequest> {
  const email = input.email.trim().toLowerCase();
  if (!isEmailLike(email)) return { ok: false, reason: 'BAD_EMAIL' };
  const workspace = input.workspace.trim().slice(0, MAX_WORKSPACE) || null;
  const locale = input.locale === 'he' ? 'he' : 'en';
  try {
    await serverApi().post({
      endpoint: accountDeletionEndpoints.request(),
      body: { email, workspace, locale },
      payload: deletionRequestedSchema,
      raw: true,
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const code = codeOf(cause, REQUEST_REFUSALS);
    if (code) return { ok: false, reason: code };
    if (isApiError(cause) && cause.status === 429) return { ok: false, reason: 'RATE_LIMITED' };
    logger.warn('account_deletion.request_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Confirm, from the email's link. ★ Called only by the person's press on
 *   "Confirm deletion": opening the link spends nothing (mail scanners open
 *   links and run their scripts).
 */
export async function confirmAccountDeletion(token: string): Promise<DeletionConfirm> {
  const sent = token.trim();
  if (!sent) return { ok: false, reason: 'BAD_TOKEN' };
  try {
    const read = await serverApi().post({
      endpoint: accountDeletionEndpoints.confirm(),
      body: { token: sent },
      payload: deletionConfirmedSchema,
      raw: true,
    });
    return { ok: true, confirmed: read.data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const code = codeOf(cause, CONFIRM_REFUSALS);
    if (code) return { ok: false, reason: code };
    if (isApiError(cause)) {
      if (cause.status === 410) return { ok: false, reason: 'TOKEN_EXPIRED' };
      if (cause.status === 409) return { ok: false, reason: 'ALREADY_CONFIRMED' };
    }
    logger.warn('account_deletion.confirm_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
