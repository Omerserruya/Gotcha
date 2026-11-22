'use server';

import { cookies } from 'next/headers';
import { getLocale } from 'next-intl/server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { termsAcceptBody, termsStateSchema } from '@/api/contracts/google-sign-in';
import { securityEndpoints } from '@/api/endpoints/registry';
import { TERMS_PENDING_COOKIE, termsPendingCookieOptions } from '@/auth/google-sign-in';
import { logger } from '@/observability/logger';

/** `accepted`: recorded (now or already); the gate opens. Anything else keeps it up. */
export type TermsAcceptResult = 'accepted' | 'failed';

/**
 * `POST /api/account/terms/accept` with the box's words as the person saw
 * them. On a 200 the sign-in's marker goes, so no door asks again.
 *
 * ★ A 503 (not recorded), a 400 (a box not ticked - the button prevents it)
 *   and a 403 (support mode, which never reaches this screen) all keep the
 *   screen up with "try again": none of them recorded anything.
 */
export async function acceptTerms(capturedText: string): Promise<TermsAcceptResult> {
  try {
    await serverApi().post({
      endpoint: securityEndpoints.acceptTerms(),
      payload: termsStateSchema,
      body: termsAcceptBody(await getLocale(), capturedText),
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('terms.accept_failed', { status: isApiError(cause) ? cause.status : undefined });
    return 'failed';
  }
  (await cookies()).delete({ name: TERMS_PENDING_COOKIE, path: termsPendingCookieOptions().path });
  return 'accepted';
}
