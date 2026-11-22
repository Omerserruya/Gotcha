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
  | {
      readonly ok: true;
      readonly email: string;
      /** The Google connection was removed because the address changed. */
      readonly googleDisconnected: boolean;
    }
  | {
      readonly ok: false;
      /**
       *   invalid            expired, or not a link we signed
       *   wrong_account      signed in as somebody else
       *   taken              the address belongs to somebody else now
       *   unfinished         the sign-in service refused; nothing changed, retry
       *   unfinished_google  the same 502, after the Google connection was
       *                      already removed: the change did not complete
       *   no_other_sign_in   Google is the only way in; a password first
       *   failed             anything else; retry
       */
      readonly reason:
        | 'invalid'
        | 'wrong_account'
        | 'taken'
        | 'unfinished'
        | 'unfinished_google'
        | 'no_other_sign_in'
        | 'failed';
    };

export async function verifyEmailChange(token: string): Promise<VerifyEmailResult> {
  try {
    const verified = await serverApi().post({
      endpoint: securityEndpoints.verifyEmailChange(),
      payload: emailChangeVerifiedSchema,
      body: { token },
    });
    return { ok: true, email: verified.email, googleDisconnected: verified.googleDisconnected };
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
      if (said === EMAIL_CHANGE_REFUSALS.noOtherSignIn) {
        return { ok: false, reason: 'no_other_sign_in' };
      }
      /*
       * The 502 that says the Google connection is already gone: the change
       * did not complete (not "nothing changed" - Backend cannot rule out a
       * write that landed at the provider), and Google must be connected again.
       */
      if (said === EMAIL_CHANGE_REFUSALS.idp) {
        return { ok: false, reason: cause.googleDisconnected ? 'unfinished_google' : 'unfinished' };
      }
    }
    return { ok: false, reason: 'failed' };
  }
}
