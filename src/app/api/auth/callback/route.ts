import { NextResponse, type NextRequest } from 'next/server';

import { LOGIN_STATE_COOKIE, unsealLoginState } from '@/auth/login-state';
import { authorizationCodeGrant, oidcConfiguration } from '@/auth/oidc';
import { sealSession, sessionCookieOptions, type Session } from '@/auth/session';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';

/**
 * Completes sign-in.
 *
 * `authorizationCodeGrant` verifies the `state` and the PKCE challenge for us;
 * a mismatch throws rather than producing a session, which is what closes the
 * CSRF and code-injection holes on this endpoint.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();
  const signInUrl = new URL('/sign-in', env.APP_ORIGIN);

  const loginState = await unsealLoginState(request.cookies.get(LOGIN_STATE_COOKIE)?.value);
  if (!loginState) {
    // Expired, replayed, or never started here.
    signInUrl.searchParams.set('error', 'expired');
    return NextResponse.redirect(signInUrl.toString());
  }

  if (request.nextUrl.searchParams.has('error')) {
    logger.warn('auth.callback.provider_error', {
      error: request.nextUrl.searchParams.get('error'),
    });
    signInUrl.searchParams.set('error', 'denied');
    return NextResponse.redirect(signInUrl.toString());
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
    return NextResponse.redirect(signInUrl.toString());
  }

  const claims = tokens.claims();
  if (!claims?.sub) {
    signInUrl.searchParams.set('error', 'exchange_failed');
    return NextResponse.redirect(signInUrl.toString());
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
    return NextResponse.redirect(signInUrl.toString());
  }

  const response = NextResponse.redirect(new URL(loginState.r, env.APP_ORIGIN).toString());
  const cookieOptions = sessionCookieOptions();
  response.cookies.set(cookieOptions.name, sealed, cookieOptions);
  response.cookies.delete({ name: LOGIN_STATE_COOKIE, path: '/api/auth' });
  return response;
}
