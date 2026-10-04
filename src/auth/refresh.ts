import 'server-only';

import { logger } from '@/observability/logger';

import { oidcConfiguration, refreshTokenGrant } from './oidc';
import type { Session } from './session';

/**
 * Spending a refresh token — the one place it happens.
 *
 * ★★ AUTHENTIK ROTATES: every refresh issues a new refresh token and the old
 * one dies (`refresh_token_threshold = 0`). So a refresh whose result is not
 * PERSISTED ends the session — the cookie keeps the spent token, and the next
 * refresh is refused. That is what signed people out every 30–60 minutes:
 * `activeSession()` refreshed inside a Server Component render, where a
 * cookie cannot be written. The proxy now refreshes before the render, where
 * it can (`src/proxy.ts`); a render never spends the token.
 *
 * In-flight refreshes are keyed by the token being spent, so six parallel
 * reads at expiry spend it once. Per server instance — the self-inflicted race.
 */
const refreshesInFlight = new Map<string, Promise<Session | null>>();

async function performRefresh(session: Session): Promise<Session | null> {
  if (!session.rt) {
    logger.warn('auth.refresh.no_refresh_token', { sessionId: session.sid });
    return null;
  }
  try {
    const tokens = await refreshTokenGrant(await oidcConfiguration(), session.rt);
    const expiresIn = tokens.expires_in ?? 300;
    return {
      ...session,
      at: tokens.access_token,
      // Rotation: the new one, always, when offered.
      rt: tokens.refresh_token ?? session.rt,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
    };
  } catch (cause) {
    // Revoked, rotated out, or ended at the identity provider: signed out.
    logger.warn('auth.refresh.failed', { sessionId: session.sid, cause });
    return null;
  }
}

/** A session with a fresh access token, or `null` when the session is over. */
export function refreshSession(session: Session): Promise<Session | null> {
  const key = session.rt ?? session.sid;
  const inFlight = refreshesInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = performRefresh(session).finally(() => {
    refreshesInFlight.delete(key);
  });
  refreshesInFlight.set(key, promise);
  return promise;
}
