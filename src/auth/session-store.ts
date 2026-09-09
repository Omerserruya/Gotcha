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

import { oidcConfiguration, refreshTokenGrant } from './oidc';

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
 * In-flight refreshes, keyed by the refresh token being spent.
 *
 * A page that fires six parallel queries the moment the access token expires
 * must not spend the refresh token six times - with rotation enabled, five of
 * those would fail and take the session down. Coalescing them into one
 * request is the fix.
 *
 * This is per server instance, which is sufficient: it removes the common
 * self-inflicted case. Cross-instance races still rely on the identity
 * provider's own replay window.
 */
const refreshesInFlight = new Map<string, Promise<Session | null>>();

async function performRefresh(session: Session): Promise<Session | null> {
  if (!session.rt) {
    // No `offline_access` grant means the session simply ends when the access
    // token does. Worth saying out loud: the symptom is a session that works
    // for five minutes and then stops, which looks like anything but this.
    logger.warn('auth.refresh.no_refresh_token', { sessionId: session.sid });
    return null;
  }
  try {
    const tokens = await refreshTokenGrant(await oidcConfiguration(), session.rt);
    const expiresIn = tokens.expires_in ?? 300;
    return {
      ...session,
      at: tokens.access_token,
      // Authentik rotates refresh tokens; keep the new one when offered.
      rt: tokens.refresh_token ?? session.rt,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
    };
  } catch (cause) {
    // A refusal here means the session is genuinely over: revoked, rotated
    // out, or the identity provider ended it. Treat it as signed out - but say
    // so, because swallowing it makes an expired session indistinguishable
    // from a backend that has stopped answering.
    logger.warn('auth.refresh.failed', { sessionId: session.sid, cause });
    return null;
  }
}

/**
 * Returns a session whose access token is usable right now, refreshing first
 * if needed.
 *
 * Persisting the refreshed cookie is attempted but not required: Next.js
 * forbids writing cookies during a Server Component render. When that happens
 * the fresh token is still used for the current request and the cookie is
 * rewritten by the next route handler or server action that refreshes. The
 * alternative - failing the render - would be strictly worse for the user.
 */
export async function activeSession(): Promise<Session | null> {
  const session = await readSession();
  if (!session) return null;
  if (!isAccessTokenExpired(session)) return session;

  const inFlight = refreshesInFlight.get(session.rt ?? session.sid);
  const refreshed = await (inFlight ??
    (() => {
      const promise = performRefresh(session).finally(() => {
        refreshesInFlight.delete(session.rt ?? session.sid);
      });
      refreshesInFlight.set(session.rt ?? session.sid, promise);
      return promise;
    })());

  if (!refreshed) {
    await tryClearSession();
    return null;
  }

  try {
    await writeSession(refreshed);
  } catch {
    // Read-only cookie context (Server Component render). See doc comment.
  }
  return refreshed;
}

async function tryClearSession(): Promise<void> {
  try {
    await clearSession();
  } catch {
    // Same read-only-context caveat as above.
  }
}
