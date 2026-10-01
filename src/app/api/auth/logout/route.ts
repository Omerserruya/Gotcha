import { NextResponse, type NextRequest } from 'next/server';

import { buildEndSessionUrl, oidcConfiguration } from '@/auth/oidc';
import { readSession } from '@/auth/session-store';
import {
  ID_TOKEN_COOKIE,
  ID_TOKEN_COOKIE_PATH,
  sessionCookieOptions,
  unsealIdToken,
} from '@/auth/session';
import { serverEnv } from '@/config/env.server';
import { assertSameOrigin } from '@/api/client/csrf';
import { logger } from '@/observability/logger';
import { appUrl } from '@/lib/base-path';
import { refuseOnCredentialSurface } from '@/api/client/credential-surface';

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
  /*
   * ★★ NOT REACHABLE ON THE SIGN-IN ORIGIN. The middleware's refusal cannot
   * see this file — its matcher excludes `/api` — so this route was covered
   * there by the gateway allowlist and by nothing else, while every page route
   * had two independent refusals.
   */
  const notHere = refuseOnCredentialSurface(request);
  if (notHere) return notHere;

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
       * ════════════════════════════════════════════════════════════════════
       * ★★ `id_token_hint` WHEN WE HAVE ONE — AND WE NOW USUALLY DO
       * ════════════════════════════════════════════════════════════════════
       * This used to say the id token could not be kept because it pushed the
       * session cookie past 4 KB. True, and the conclusion drawn from it was
       * wrong: **the limit is per cookie, not per domain.** It now lives in
       * its own cookie scoped to this path, so it is sent here and nowhere
       * else.
       *
       * Without the hint, RP-initiated logout can only offer `client_id` —
       * which says which application is asking but not WHO — so the provider
       * asks the person to confirm, on its own page, in its own vocabulary.
       * That screen is the entire cost, and it is what a reviewer
       * photographed.
       *
       * ⚠ THE FALLBACK IS THE OLD BEHAVIOUR, DELIBERATELY. An older session,
       *   a cleared cookie, a rotated secret, a grant with no id token: every
       *   one of those omits the hint and gets the confirmation screen. **A
       *   sign-out that asks is far better than a sign-out that fails**, and
       *   a truncated or malformed hint risks the second.
       */
      const idToken = await unsealIdToken(request.cookies.get(ID_TOKEN_COOKIE)?.value);

      redirectTo = buildEndSessionUrl(await oidcConfiguration(), {
        ...(idToken ? { id_token_hint: idToken } : { client_id: env.OIDC_CLIENT_ID }),
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

  /*
   * ⚠⚠ AND THE HINT GOES WITH IT. A sealed id token that outlives the session
   *   it describes is a stale credential sitting in a browser for nothing —
   *   and on the next sign-out it would be sent as a hint for a session that
   *   no longer exists.
   *
   * ★ The path must MATCH THE SETTER exactly. A delete whose path does not
   *   match is a silent no-op, which is how a cookie survives a sign-out
   *   while every test asserting "we called delete" still passes.
   */
  response.cookies.delete({ name: ID_TOKEN_COOKIE, path: ID_TOKEN_COOKIE_PATH });
  return response;
}
