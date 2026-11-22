'use server';

import { cookies } from 'next/headers';

import { signInIfSignedOut } from '@/api/client/signed-out';
import { connectCookieOptions, sealConnectIntent } from '@/auth/google-sign-in';
import { activeSession } from '@/auth/session-store';
import { logger } from '@/observability/logger';

/**
 * ★★ CONNECT GOOGLE, STEP ONE OF TWO: REMEMBER WHO, WHILE STILL SIGNED IN.
 *
 * Connecting is "sign out, then sign in with Google" (Supervisor): the
 * provider links ANY Google account to a live session with no email check,
 * so the source is never opened while signed in. This seals the person's
 * subject into its own cookie (auth/google-sign-in.ts); the button then signs
 * out, and the callback after the Google sign-in hands the subject to Backend.
 *
 * `ready`: sign out now. `failed`: no session to remember - nothing is set,
 * and nothing should be signed out on its account.
 */
export async function beginGoogleConnect(): Promise<'ready' | 'failed'> {
  const session = await activeSession();
  if (!session) return 'failed';
  try {
    const options = connectCookieOptions();
    (await cookies()).set(options.name, await sealConnectIntent(session.sub), options);
    return 'ready';
  } catch (cause) {
    // The repo's rule for every action's catch (server-actions-sign-in.test.ts).
    await signInIfSignedOut(cause);
    logger.warn('security.google_connect_begin_failed', { cause });
    return 'failed';
  }
}
