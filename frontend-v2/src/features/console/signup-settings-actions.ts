'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  signUpSettingsBody,
  signUpSettingsSchema,
  type SignUpSettingsWrite,
} from '@/api/contracts/self-signup';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type SignUpSettingsResult = 'saved' | 'invalid' | 'forbidden' | 'failed';

/** Saves the switch and the three numbers - whole, as the server reads them. */
export async function saveSignUpSettings(
  settings: SignUpSettingsWrite,
): Promise<SignUpSettingsResult> {
  try {
    await serverApi().put({
      endpoint: consoleEndpoints.signUpSettings(),
      payload: signUpSettingsSchema,
      body: signUpSettingsBody(settings),
      raw: true,
    });
    revalidatePath('/[locale]/system/signup', 'page');
    return 'saved';
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('console.signup_settings_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 400 || cause.status === 422) return 'invalid';
      if (cause.status === 403) return 'forbidden';
    }
    return 'failed';
  }
}
