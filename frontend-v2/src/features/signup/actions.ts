'use server';

import { getLocale } from 'next-intl/server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  refusedFieldOf,
  signUpBody,
  signUpFieldOf,
  signUpSentSchema,
  type SignUpForm,
  type SignUpOutcome,
} from '@/api/contracts/self-signup';
import { publicLinkEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Self sign-up's submit. Nothing here logs the address or the name.
 *
 * ★ Every accepted request is `sent`, the same screen whether or not the
 *   address already has an account: the form must not become an account list.
 */
export async function submitSignUp(
  form: SignUpForm,
  capturedText: string,
  website = '',
): Promise<SignUpOutcome> {
  try {
    await serverApi().post({
      endpoint: publicLinkEndpoints.signUp(),
      payload: signUpSentSchema,
      body: signUpBody(form, await getLocale(), capturedText, website),
      raw: true,
    });
    return { kind: 'sent' };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 429) return { kind: 'rateLimited' };
      if (cause.status === 404 || cause.status === 403) return { kind: 'closed' };
      if (cause.status === 400 || cause.status === 422) {
        return {
          kind: 'invalid',
          field:
            refusedFieldOf(cause.fields) ??
            signUpFieldOf(cause.field ?? cause.fieldErrors?.[0]?.field),
        };
      }
    }
    logger.warn('signup.submit_failed', { status: isApiError(cause) ? cause.status : undefined });
    return { kind: 'failed' };
  }
}
