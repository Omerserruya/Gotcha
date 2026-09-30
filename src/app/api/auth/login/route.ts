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
  randomNonce,
  calculatePKCECodeChallenge,
  oidcConfiguration,
  randomPKCECodeVerifier,
  randomState,
  redirectUri,
} from '@/auth/oidc';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';
import { refuseOnCredentialSurface } from '@/api/client/credential-surface';

/**
 * Marks the one arrival that may start OIDC directly: our own panel, handing
 * over after it has already created the provider session.
 *
 * Exported so the page that builds the hand-over URL uses the same string.
 * Two spellings of a routing hint is one spelling too many — the failure would
 * be a redirect loop between this route and the panel, on the front door.
 */
export const HANDOVER_PARAM = 'handover';

/**
 * Begins sign-in: Authorization Code + PKCE against Authentik.
 *
 * The code verifier and the CSRF `state` travel in a short-lived encrypted
 * cookie rather than in server memory, so this works unchanged behind any
 * number of instances.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  /*
   * ★★ NOT REACHABLE ON THE SIGN-IN ORIGIN. The middleware's refusal cannot
   * see this file — its matcher excludes `/api` — so this route was covered
   * there by the gateway allowlist and by nothing else, while every page route
   * had two independent refusals.
   */
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;

  const returnTo = safeReturnPath(request.nextUrl.searchParams.get('returnTo'));

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * ⚠⚠ THE SECOND DOOR TO THE PURPLE PAGE, AND NOTHING WAS IN FRONT OF IT
   * ═════════════════════════════════════════════════════════════════════════
   * This route IS the OIDC start, so it goes straight to `authorize` — and with
   * no identity-provider session the provider renders **its own login page**,
   * which is the screen the whole separation exists to stop anyone seeing.
   * The middleware cannot help: its matcher excludes `/api`.
   *
   * Omer reached it twice from a bookmark carrying
   * `?next=/application/o/authorize/`. It is not only bookmarks —
   * `SessionExpiryWatcher` comes here too, so a session expiring mid-work
   * handed somebody the provider's UI rather than ours.
   *
   * ★ THE GATE AND THIS ROUTE GAVE TWO DIFFERENT ANSWERS TO ONE QUESTION.
   *   `proxy.ts` sends an unauthenticated visitor to `SIGN_IN_URL`; this sent
   *   them to the provider. "One way in" is the design, and two entrances
   *   disagreeing is how the second one goes unnoticed.
   *
   * ── THE MARKER IS A ROUTING HINT, NOT A SECURITY CONTROL ──
   * Anyone can append it, and that is fine: the worst a forged one achieves is
   * seeing the provider's page, which is what happened before. What it buys is
   * that the ONE legitimate direct caller — our panel, handing over after it
   * has already created the provider session — keeps working, while every
   * other arrival is sent to the panel first.
   *
   * ⚠ IT CHANGES SESSION EXPIRY, DELIBERATELY AND NOT COSTLESSLY. Before, an
   *   expiring session bounced through `authorize` and was restored silently
   *   when the provider session was still alive. Now it shows our sign-in
   *   screen. That is the design's behaviour and it is consistent with the
   *   front door, but it is a real regression for the common case and it
   *   should be a decision rather than a side effect — the cure is a silent
   *   attempt from the panel itself, which is not built.
   */
  const signInElsewhere = process.env.SIGN_IN_URL;
  if (signInElsewhere && request.nextUrl.searchParams.get(HANDOVER_PARAM) !== '1') {
    const panel = new URL(signInElsewhere);
    panel.searchParams.set('returnTo', returnTo);
    const toThePanel = NextResponse.redirect(panel);
    toThePanel.headers.set('cache-control', 'no-store');
    return toThePanel;
  }

  const env = serverEnv();

  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = randomState();
  /*
   * ═══════════════════════════════════════════════════════════════════════
   * ★★ PKCE BINDS THE CODE. THE NONCE BINDS THE ID TOKEN. BOTH, NOT EITHER.
   * ═══════════════════════════════════════════════════════════════════════
   * This request carried `state` and a PKCE challenge and no nonce. PKCE
   * proves the code is being redeemed by whoever asked for it; it says
   * nothing about the ID TOKEN that comes back. The nonce is what ties that
   * token to this particular sign-in, and `openid-client` will check it for
   * us when we say what to expect.
   */
  const nonce = randomNonce();

  const authorizationUrl = buildAuthorizationUrl(await oidcConfiguration(), {
    redirect_uri: redirectUri(),
    scope: env.OIDC_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
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
    await sealLoginState({ v: codeVerifier, s: state, r: returnTo, n: nonce }),
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
