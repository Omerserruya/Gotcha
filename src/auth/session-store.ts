import 'server-only';

import { cookies } from 'next/headers';

import {
  isAccessTokenExpired,
  sealSession,
  sessionCookieOptions,
  unsealSession,
  type Session,
} from './session';
import { logger } from '@/observability/logger';

import { refreshSession } from './refresh';

/**
 * Reads the session as it currently stands, without touching Authentik.
 *
 * Safe to call from a Server Component. Returns `null` when there is no valid
 * session; the access token it returns may already be expired, so anything
 * that is about to call the platform API should use `activeSession()`.
 */
export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  return unsealSession(store.get(sessionCookieOptions().name)?.value);
}

export async function writeSession(session: Session): Promise<void> {
  const options = sessionCookieOptions();
  const store = await cookies();
  store.set(options.name, await sealSession(session), options);
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(sessionCookieOptions().name);
}

/**
 * Returns a session whose access token is usable right now.
 *
 * ★★ IT REFRESHES ONLY WHERE THE RESULT CAN BE KEPT. With rotation, a refresh
 * spends the refresh token; one done inside a Server Component render — where
 * a cookie cannot be written — left the cookie holding the spent token, and
 * the next refresh ended the session. So:
 *
 *   · the proxy refreshes ahead of expiry, before every page render, and
 *     writes the cookie on the response and on the request (`src/proxy.ts`);
 *   · here, an expired token is refreshed only when the cookie can be written
 *     (a route handler, a server action). In a render it is not refreshed:
 *     the session is reported over, and the layout sends the user to sign in.
 */
export async function activeSession(): Promise<Session | null> {
  const session = await readSession();
  if (!session) return null;
  if (!isAccessTokenExpired(session)) return session;

  // Can this context keep a cookie? Rewriting the same value answers it, and
  // is harmless where it can.
  try {
    await writeSession(session);
  } catch {
    logger.warn('auth.refresh.not_in_render', { sessionId: session.sid });
    return null;
  }

  const refreshed = await refreshSession(session);
  if (!refreshed) {
    await clearSession();
    return null;
  }
  await writeSession(refreshed);
  return refreshed;
}
