'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { DISCONNECT_REFUSALS, disconnectedSchema } from '@/api/contracts/google-sign-in';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * `refused`: Google is the only way in (`409 no_other_sign_in`, Backend's
 * rule - never guessed here). `gone`: already not connected, or Google is off.
 */
export type GoogleDisconnectResult = 'disconnected' | 'refused' | 'gone' | 'failed';

export async function disconnectGoogle(): Promise<GoogleDisconnectResult> {
  try {
    await serverApi().delete({
      endpoint: securityEndpoints.googleConnection(),
      payload: disconnectedSchema,
      raw: true,
    });
    revalidatePath('/[locale]/settings/security', 'page');
    return 'disconnected';
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('security.google_disconnect_failed', { cause });
    if (isApiError(cause)) {
      if (cause.developerMessage === DISCONNECT_REFUSALS.noOtherSignIn) return 'refused';
      if (
        cause.developerMessage === DISCONNECT_REFUSALS.notConnected ||
        cause.developerMessage === DISCONNECT_REFUSALS.notAvailable
      ) {
        revalidatePath('/[locale]/settings/security', 'page');
        return 'gone';
      }
    }
    return 'failed';
  }
}
