import 'server-only';

import { logger } from '@/observability/logger';

import { oidcConfiguration, refreshTokenGrant } from './oidc';
import type { Session } from './session';

/**
 * Spending a refresh token - the one place it happens.
 *
 * ★★ AUTHENTIK ROTATES: every refresh issues a new refresh token and the old
 * one dies (`refresh_token_threshold = 0`). So a refresh whose result is not
 * PERSISTED ends the session - the cookie keeps the spent token, and the next
 * refresh is refused. That is what signed people out every 30-60 minutes:
 * `activeSession()` refreshed inside a Server Component render, where a
 * cookie cannot be written. The proxy now refreshes before the render, where
 * it can (`src/proxy.ts`); a render never spends the token.
 *
 * In-flight refreshes are keyed by the token being spent, so six parallel
 * reads at expiry spend it once.
 *
 * ★★ AND A REFRESH IS REMEMBERED FOR A SHORT WHILE AFTER IT SETTLES. A
 *   request that left the browser with the old cookie and arrives a moment
 *   after the refresh finished (prefetches, a poll, a second tab) used to find
 *   no entry and spend the dead token: refused, so its response CLEARED the
 *   cookie the previous response had just renewed - signed out, with a live
 *   session at the identity provider. Within `SPENT_GRACE_MS` it gets the
 *   same new tokens instead, and its response sets the same cookie.
 * ★ One map per process, on `globalThis`: the proxy and the route handlers
 *   are separate bundles, and a module-level map was one map EACH - the
 *   proxy and a BFF read could each spend the same token.
 */
export const SPENT_GRACE_MS = 30_000;

interface Refreshes {
  readonly inFlight: Map<string, Promise<Session | null>>;
  /** Spent token → what spending it gave, until `until`. */
  readonly settled: Map<string, { readonly result: Session | null; readonly until: number }>;
}
const REFRESHES = Symbol.for('gotcha.auth.refreshes');
const refreshes: Refreshes = ((globalThis as Record<symbol, Refreshes | undefined>)[REFRESHES] ??= {
  inFlight: new Map(),
  settled: new Map(),
});

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
  const now = Date.now();
  for (const [spent, { until }] of refreshes.settled) {
    if (until <= now) refreshes.settled.delete(spent);
  }
  const settled = refreshes.settled.get(key);
  if (settled) return Promise.resolve(settled.result);
  const inFlight = refreshes.inFlight.get(key);
  if (inFlight) return inFlight;
  const promise = performRefresh(session)
    .then((result) => {
      // Only a success is kept: a refusal is not retried by anyone anyway.
      if (result) refreshes.settled.set(key, { result, until: Date.now() + SPENT_GRACE_MS });
      return result;
    })
    .finally(() => {
      refreshes.inFlight.delete(key);
    });
  refreshes.inFlight.set(key, promise);
  return promise;
}
