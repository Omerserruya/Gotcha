import { NextResponse, type NextRequest } from 'next/server';

import { LOGIN_STATE_COOKIE, LOGIN_STATE_COOKIE_PATH, unsealLoginState } from '@/auth/login-state';
import { authorizationCodeGrant, oidcConfiguration } from '@/auth/oidc';
import { sealSession, sessionCookieOptions, type Session } from '@/auth/session';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';
import { appUrl } from '@/lib/base-path';
import { refuseOnCredentialSurface } from '@/api/client/credential-surface';

/**
 * Completes sign-in.
 *
 * `authorizationCodeGrant` verifies the `state` and the PKCE challenge for us;
 * a mismatch throws rather than producing a session, which is what closes the
 * CSRF and code-injection holes on this endpoint.
 */
/**
 * Every answer this endpoint gives is about one single-use code.
 *
 * ★★ NONE OF THEM MAY BE STORED. The success path carries a `Set-Cookie`
 * holding a sealed session; the failure paths carry a reason for one specific
 * attempt. A replayed copy of either is a stale answer to a question the
 * browser thinks it just asked — somebody who has signed out being sent onward
 * by a redirect recorded while they were signed in, or a stale
 * `?error=expired` shown after a sign-in that actually worked.
 *
 * ★ Not a claim that a shared cache would hold these. They are `Set-Cookie`
 *   responses on a 307, which a shared cache must not store anyway, and 307 is
 *   not on RFC 9111’s heuristic list. It is the browser’s own back/forward and
 *   in-memory caches this speaks to, which obey `no-store` and do not consult
 *   that rule.
 */
function uncached(response: NextResponse): NextResponse {
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  /*
   * ★★ NOT REACHABLE ON THE SIGN-IN ORIGIN. The middleware's refusal cannot
   * see this file — its matcher excludes `/api` — so this route was covered
   * there by the gateway allowlist and by nothing else, while every page route
   * had two independent refusals.
   */
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;

  const env = serverEnv();
  // See `redirectUri`: an absolute path would discard the mount point.
  const signInUrl = new URL(appUrl('/sign-in', env.APP_ORIGIN));

  const loginState = await unsealLoginState(request.cookies.get(LOGIN_STATE_COOKIE)?.value);
  if (!loginState) {
    // Expired, replayed, or never started here.
    signInUrl.searchParams.set('error', 'expired');
    return uncached(NextResponse.redirect(signInUrl.toString()));
  }

  if (request.nextUrl.searchParams.has('error')) {
    logger.warn('auth.callback.provider_error', {
      error: request.nextUrl.searchParams.get('error'),
    });
    signInUrl.searchParams.set('error', 'denied');
    return uncached(NextResponse.redirect(signInUrl.toString()));
  }

  let tokens;
  try {
    /*
     * `request.nextUrl` is a NextURL, not a URL, and openid-client rejects it
     * with `instanceof`. Rebuilding on APP_ORIGIN also pins the origin to the
     * one that produced the registered redirect_uri, rather than trusting
     * whatever host header reached us.
     */
    const currentUrl = new URL(
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
      env.APP_ORIGIN,
    );
    tokens = await authorizationCodeGrant(await oidcConfiguration(), currentUrl, {
      pkceCodeVerifier: loginState.v,
      expectedState: loginState.s,
    });
  } catch (cause) {
    logger.error('auth.callback.exchange_failed', { cause });
    signInUrl.searchParams.set('error', 'exchange_failed');
    return uncached(NextResponse.redirect(signInUrl.toString()));
  }

  const claims = tokens.claims();
  if (!claims?.sub) {
    signInUrl.searchParams.set('error', 'exchange_failed');
    return uncached(NextResponse.redirect(signInUrl.toString()));
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const session: Session = {
    sub: claims.sub,
    sid: globalThis.crypto.randomUUID(),
    at: tokens.access_token,
    rt: tokens.refresh_token,
    exp: nowSeconds + (tokens.expires_in ?? 300),
    abs: nowSeconds + env.SESSION_MAX_AGE_SECONDS,
  };

  logger.info('auth.callback.success', { sessionId: session.sid });

  let sealed;
  try {
    sealed = await sealSession(session);
  } catch (cause) {
    // Setting it anyway would produce a cookie the browser discards, i.e. an
    // endless sign-in loop. One legible failure is better.
    logger.error('auth.callback.session_too_large', { cause });
    signInUrl.searchParams.set('error', 'session_too_large');
    return uncached(NextResponse.redirect(signInUrl.toString()));
  }

  /*
   * ★★ AND THIS ONE IS WHERE THE USER ACTUALLY LANDS AFTER SIGNING IN.
   *
   * `NextResponse.redirect` builds a raw `Response` and **does not apply the
   * base path** — unlike `redirect()` from `next/navigation`. `loginState.r`
   * is an unprefixed in-app path (`safeReturnPath` guarantees a leading slash
   * or `/`), so under a mount point this sent people to the root after a
   * successful sign-in: the legacy product, with a valid session for this one.
   *
   * The most invisible failure of the whole set, because it only happens after
   * a login that worked.
   */
  const response = NextResponse.redirect(appUrl(loginState.r as `/${string}`, env.APP_ORIGIN));
  const cookieOptions = sessionCookieOptions();
  response.cookies.set(cookieOptions.name, sealed, cookieOptions);
  // Same constant as the setter: a delete whose path does not match is a
  // no-op, and a stale sealed state can be picked up by the next attempt.
  response.cookies.delete({ name: LOGIN_STATE_COOKIE, path: LOGIN_STATE_COOKIE_PATH });
  return uncached(response);
}
