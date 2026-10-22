'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { publicLinkEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * "Email me a new link" (legacy `frontend/src/app/setup-link/expired/page.tsx`).
 *
 * `POST /api/auth/setup/resend` `{ token }` (services/auth setup-link.ts:176)
 * answers the same `{ ok: true }` whatever happened - an unknown token, a
 * failed send - so it cannot be used to learn whether an account exists. So
 * "sent" here means "asked", and the screen says no more than that.
 *
 * It is rate-limited (5 an hour, setup-link.ts:36): a 429 is its own reason,
 * because "try again" would be the wrong advice for the next hour.
 */
export type ResendSetupLinkResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'rate_limited' | 'failed' };

export async function resendSetupLink(token: string): Promise<ResendSetupLinkResult> {
  try {
    await serverApi().post({
      endpoint: publicLinkEndpoints.resendSetup(),
      // The answer is the same for every token; nothing in it is read.
      payload: z.unknown(),
      body: { token },
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('setup_link.resend_failed', { cause });
    if (isApiError(cause) && cause.status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'failed' };
  }
}
