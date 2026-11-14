import 'server-only';

import { z } from 'zod';

import { consoleEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';
import { readSupport } from '@/support/support-cookie';

/** A sign-out does not wait on the platform for longer than this. */
const END_TIMEOUT_MS = 3000;

/**
 * Ends the support session this browser holds, as part of signing out.
 *
 * ★★ THE PLATFORM CANNOT SEE A v2 SIGN-OUT (Backend 41755eb2): its own logout
 *   ends a support session, but this app signs out at the provider, not
 *   there. Without this call a session outlives the sign-out until its expiry
 *   - two hours of a workspace open to a login that has ended.
 *
 * Before the cookies go: the end is the admin's call, made with the session
 * being ended. Best effort and bounded - a sign-out never fails, or waits,
 * because the platform did. A session this browser does not hold (another
 * browser's) is not seen here; it ends at its expiry.
 */
export async function endSupportOnLogout(): Promise<void> {
  try {
    const held = await readSupport();
    if (!held) return;
    await serverApi().post({
      endpoint: consoleEndpoints.endSupportSession(held.id),
      payload: z.unknown(),
      timeoutMs: END_TIMEOUT_MS,
    });
    logger.info('support.ended_on_logout', { supportSessionId: held.id });
  } catch (cause) {
    logger.warn('support.end_on_logout_failed', { cause });
  }
}
