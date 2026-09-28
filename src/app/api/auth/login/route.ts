import { NextResponse, type NextRequest } from 'next/server';

import {
  LOGIN_STATE_COOKIE,
  LOGIN_STATE_COOKIE_PATH,
  LOGIN_STATE_MAX_AGE_SECONDS,
  safeReturnPath,
  sealLoginState,
} from '@/auth/login-state';
import {
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  oidcConfiguration,
  randomPKCECodeVerifier,
  randomState,
  redirectUri,
} from '@/auth/oidc';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';

/**
 * Begins sign-in: Authorization Code + PKCE against Authentik.
 *
 * The code verifier and the CSRF `state` travel in a short-lived encrypted
 * cookie rather than in server memory, so this works unchanged behind any
 * number of instances.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get('returnTo'));

  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = randomState();

  const authorizationUrl = buildAuthorizationUrl(await oidcConfiguration(), {
    redirect_uri: redirectUri(),
    scope: env.OIDC_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    ...(request.nextUrl.searchParams.get('login_hint')
      ? { login_hint: request.nextUrl.searchParams.get('login_hint') as string }
      : {}),
  });

  logger.debug('auth.login.start', { returnTo });

  const response = NextResponse.redirect(authorizationUrl.toString());
  /*
   * This response carries the sealed PKCE verifier and the CSRF `state` in a
   * cookie, and its `Location` embeds a one-time `state` and code challenge.
   * A replayed copy hands somebody a stale challenge against a fresh cookie,
   * which fails at the callback as "expired" with nothing to explain it.
   */
  response.headers.set('cache-control', 'no-store');
  response.cookies.set(
    LOGIN_STATE_COOKIE,
    await sealLoginState({ v: codeVerifier, s: state, r: returnTo }),
    {
      httpOnly: true,
      secure: !env.APP_ORIGIN.startsWith('http://'),
      sameSite: 'lax',
      path: LOGIN_STATE_COOKIE_PATH,
      maxAge: LOGIN_STATE_MAX_AGE_SECONDS,
    },
  );
  return response;
}
