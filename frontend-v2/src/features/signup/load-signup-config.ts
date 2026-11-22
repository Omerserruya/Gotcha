import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { signUpConfigSchema, type SignUpConfig } from '@/api/contracts/self-signup';
import { publicLinkEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

const CLOSED: SignUpConfig = { enabled: false, trialDays: null, cardRequiredAfterDays: null };

/**
 * Whether self sign-up is open, and its trial - read with no session (the
 * sign-in and sign-up pages are public). Unread is CLOSED: a visitor is never
 * offered a form the server might refuse, and nothing shows until the
 * server's flag is on (Supervisor, 2026-11-22).
 */
export async function loadSignUpConfig(): Promise<SignUpConfig> {
  try {
    return await serverApi().get({
      endpoint: publicLinkEndpoints.signUpConfig(),
      payload: signUpConfigSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('signup.config_unread', { cause });
    return CLOSED;
  }
}
