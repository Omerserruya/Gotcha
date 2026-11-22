import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { signUpSettingsSchema, type SignUpSettings } from '@/api/contracts/self-signup';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** Self sign-up's settings, or `null` when unread - never a default that looks like the truth. */
export async function loadSignUpSettings(): Promise<SignUpSettings | null> {
  try {
    return await serverApi().get({
      endpoint: consoleEndpoints.signUpSettings(),
      payload: signUpSettingsSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('console.signup_settings_unread', { cause });
    return null;
  }
}
