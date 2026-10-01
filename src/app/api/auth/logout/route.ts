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
/**
 * The sealed id token, or null — and it NEVER throws.
 *
 * ★ Separate from the end-session call so that a hint we cannot read costs a
 *   confirmation screen rather than the whole sign-out. Every failure here is
 *   "no hint", which is the behaviour this route had before hints existed.
 */
async function readHint(request: NextRequest): Promise<string | null> {
  try {
    return await unsealIdToken(request.cookies.get(ID_TOKEN_COOKIE)?.value);
  } catch (cause) {
    logger.warn('auth.logout.hint_unreadable', { cause });
    return null;
  }
}

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
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * ⚠⚠ READ THE HINT FIRST, AND OUTSIDE THE TRY. THIS IS WHY.
   * ════════════════════════════════════════════════════════════════════════════
   * The first version read it INSIDE the try whose catch falls back to a
   * local redirect. That catch exists for one thing — a provider with no
   * `end_session_endpoint` — and putting anything else inside it means any
   * failure there silently turns a sign-out into a redirect that signs
   * nobody out of anything.
   *
   * ★ A sign-out that does not reach the provider is not a sign-out. It is
   *   worse than the confirmation screen it was meant to remove, because the
   *   screen at least ended the session.
   */
  const idToken = await readHint(request);

  let redirectTo = appUrl('/sign-in', env.APP_ORIGIN);
  let reachedProvider = false;

  if (session) {
    try {
      /*
       * Without a hint, RP-initiated logout can only offer `client_id` —
       * which says which application is asking but not WHO — so the provider
       * asks the person to confirm, on its own page, in its own vocabulary.
       * That screen is the entire cost of the fallback, and it is what a
       * reviewer photographed.
       */
      redirectTo = buildEndSessionUrl(await oidcConfiguration(), {
        ...(idToken ? { id_token_hint: idToken } : { client_id: env.OIDC_CLIENT_ID }),
        post_logout_redirect_uri: appUrl('/sign-in', env.APP_ORIGIN),
      }).toString();
      reachedProvider = true;
    } catch (cause) {
      /*
       * ⚠ NO LONGER SILENT. This swallowed its reason, and a sign-out that
       *   quietly stops calling the provider is the one failure that looks
       *   like success from the outside — it lands on our sign-in page, which
       *   is exactly where a working sign-out lands.
       */
      logger.error('auth.logout.no_end_session', { cause });
    }
  }

  /*
   * ⚠⚠ THE PROPERTY, STATED WHERE IT CAN BE SEEN: a session that existed
   *   must have produced a provider URL. `redirectTo` being a valid string is
   *   not the same as it pointing anywhere useful, and a local URL is a valid
   *   string and a passing shape.
   */
  logger.info('auth.logout', {
    sessionId: session?.sid,
    reachedProvider,
    hinted: Boolean(idToken),
  });

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
