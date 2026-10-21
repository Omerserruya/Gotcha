'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { EMAIL_CHANGE_REFUSALS, emailChangeVerifiedSchema } from '@/api/contracts/email-change';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Confirms a change of sign-in address (legacy
 * `frontend/src/app/account/verify-email/page.tsx`). Nothing here logs the
 * token or either address.
 */
export type VerifyEmailResult =
  | { readonly ok: true; readonly email: string }
  | {
      readonly ok: false;
      /**
       *   invalid        expired, or not a link we signed
       *   wrong_account  signed in as somebody else
       *   taken          the address belongs to somebody else now
       *   unfinished     the sign-in service refused; nothing changed, retry
       *   failed         anything else; retry
       */
      readonly reason: 'invalid' | 'wrong_account' | 'taken' | 'unfinished' | 'failed';
    };

export async function verifyEmailChange(token: string): Promise<VerifyEmailResult> {
  try {
    const verified = await serverApi().post({
      endpoint: securityEndpoints.verifyEmailChange(),
      payload: emailChangeVerifiedSchema,
      body: { token },
    });
    return { ok: true, email: verified.email };
  } catch (cause) {
    // Signed out since the page opened: sign-in, then back to this link.
    await signInIfSignedOut(cause);
    logger.warn('account.verify_email_failed', { cause });
    if (isApiError(cause)) {
      const said = cause.developerMessage;
      if (said === EMAIL_CHANGE_REFUSALS.invalid) return { ok: false, reason: 'invalid' };
      if (said === EMAIL_CHANGE_REFUSALS.wrongAccount)
        return { ok: false, reason: 'wrong_account' };
      if (said === EMAIL_CHANGE_REFUSALS.taken) return { ok: false, reason: 'taken' };
      if (said === EMAIL_CHANGE_REFUSALS.idp) return { ok: false, reason: 'unfinished' };
    }
    return { ok: false, reason: 'failed' };
  }
}
