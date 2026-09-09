import { NextResponse, type NextRequest } from 'next/server';

import { buildEndSessionUrl, oidcConfiguration } from '@/auth/oidc';
import { readSession } from '@/auth/session-store';
import { sessionCookieOptions } from '@/auth/session';
import { serverEnv } from '@/config/env.server';
import { assertSameOrigin } from '@/api/client/csrf';
import { logger } from '@/observability/logger';

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

  let redirectTo = new URL('/sign-in', env.APP_ORIGIN).toString();
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
        post_logout_redirect_uri: new URL('/sign-in', env.APP_ORIGIN).toString(),
      }).toString();
    } catch {
      // No end-session endpoint advertised; local sign-out is enough.
    }
  }

  logger.info('auth.logout', { sessionId: session?.sid });

  const response = NextResponse.json({ redirectTo });
  response.cookies.delete({ name: sessionCookieOptions().name, path: '/' });
  return response;
}
