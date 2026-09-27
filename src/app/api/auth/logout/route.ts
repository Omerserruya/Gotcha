import { NextResponse, type NextRequest } from 'next/server';

import { buildEndSessionUrl, oidcConfiguration } from '@/auth/oidc';
import { readSession } from '@/auth/session-store';
import { sessionCookieOptions } from '@/auth/session';
import { serverEnv } from '@/config/env.server';
import { assertSameOrigin } from '@/api/client/csrf';
import { logger } from '@/observability/logger';
import { appUrl } from '@/lib/base-path';

/**
 * Ends the session.
 *
 * POST rather than GET: signing a user out is a state change, and a GET would
 * let any page on the internet log our users out with an `<img>` tag. The
 * Origin check closes the same hole for form posts.
 *
 * The local cookie is cleared unconditionally. Ending the Authentik session
 * too is best-effort - if the provider has no end-session endpoint we still
 * want the local sign-out to have happened.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = assertSameOrigin(request);
  if (originError) return originError;

  const env = serverEnv();
  const session = await readSession();

  // `appUrl`, not `new URL('/sign-in', …)`: an absolute path discards the
  // origin's own path, which is where this app is mounted.
  let redirectTo = appUrl('/sign-in', env.APP_ORIGIN);
  if (session) {
    try {
      /*
       * `id_token_hint` would be the stronger hint, but keeping an id token in
       * the session pushed the cookie past the 4 KB browser limit (see
       * MAX_COOKIE_BYTES). RP-initiated logout permits `client_id` instead
       * when the hint is absent, which is what identifies us here. The cost is
       * that the provider may ask the user to confirm the sign-out.
       */
      redirectTo = buildEndSessionUrl(await oidcConfiguration(), {
        client_id: env.OIDC_CLIENT_ID,
        post_logout_redirect_uri: appUrl('/sign-in', env.APP_ORIGIN),
      }).toString();
    } catch {
      // No end-session endpoint advertised; local sign-out is enough.
    }
  }

  logger.info('auth.logout', { sessionId: session?.sid });

  const response = NextResponse.json({ redirectTo });
  /*
   * ★ THE COOKIE PATH STAYS `/`, DELIBERATELY.
   *
   * Scoping it to the mount point would look tidier and would break the one
   * thing that matters: `/api/auth/callback` and the BFF both sit under the
   * prefix, but a cookie written at `/v2` is not sent to `/` — and nothing
   * here needs it to be. What decides it is the other direction: the two
   * applications use DIFFERENT cookie names, so a root-scoped cookie cannot
   * collide with the legacy session — and the whole safety argument rests on
   * those names, so they are worth getting right:
   *
   *     this app      gotcha_session            (both environments)
   *     the platform  __Host-gotcha_session     in PRODUCTION
   *                   gotcha_session_dev        in DEV
   *
   * An earlier version of this comment named only the production one, which
   * would have left somebody checking dev against the wrong string. The pair
   * is distinct in both, so the conclusion holds.
   *
   * Narrowing the path would buy isolation the name already provides, while
   * adding a way to lose the session on a path this app does not control.
   */
  response.cookies.delete({ name: sessionCookieOptions().name, path: '/' });
  return response;
}
