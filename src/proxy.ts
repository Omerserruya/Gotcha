import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { routing } from '@/i18n/routing';
import {
  buildContentSecurityPolicy,
  generateNonce,
  NONCE_HEADER,
} from '@/observability/content-security-policy';

const intlMiddleware = createIntlMiddleware(routing);

/**
 * Locale resolution, a coarse authentication gate, and the per-request CSP.
 *
 * The gate here is a redirect, not a security control: it checks only that a
 * session cookie is present, because this runs on every request and decrypting
 * on each one would be wasteful. The real check happens where the data is -
 * the layout resolves the session properly, and the platform API rejects any
 * request whose token does not hold up.
 *
 * Getting this backwards is a classic mistake: an edge check that "protects" a
 * route while the route itself trusts it.
 */
const PUBLIC_PATH_PATTERN = /^\/(?:[a-z]{2}\/)?(?:sign-in)(?:\/|$)/;

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    realtimeUrl: process.env.NEXT_PUBLIC_REALTIME_URL,
    isDevelopment: process.env.NODE_ENV !== 'production',
    /*
     * ★★ THE SIGN-IN ROUTE NOW HOLDS A PASSWORD FIELD IN OUR OWN BUNDLE.
     * Until screen 00a, the credential was typed on the identity provider's
     * origin and an injected script here could not reach it. It narrows
     * `img-src`, `media-src`, `connect-src` and `frame-src` — the ways a value
     * leaves a page — on exactly the route that has one to lose.
     *
     * The same pattern already decides which routes are public, and it is reused
     * rather than copied: two lists of "which pages are the sign-in" would be
     * one list too many, and the one that drifts would be this one.
     */
    credentialSurface: PUBLIC_PATH_PATTERN.test(pathname),
  });

  /*
   * The nonce must reach the render, and Next.js reads it from the
   * `content-security-policy` REQUEST header - that is what makes it stamp its
   * own bootstrap scripts. So the header goes on the request as well as the
   * response, and `x-nonce` is carried alongside for our own inline script.
   */
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('content-security-policy', csp);

  const withSecurityHeaders = (response: NextResponse): NextResponse => {
    response.headers.set('content-security-policy', csp);
    response.headers.set(NONCE_HEADER, nonce);
    return response;
  };

  if (!PUBLIC_PATH_PATTERN.test(pathname)) {
    /*
     * Either session counts. This is a redirect, not a security control — it
     * only avoids rendering a shell that is about to 401, and the real check
     * happens where the data is.
     */
    const platformCookieName = process.env.PLATFORM_SESSION_COOKIE;
    const hasSessionCookie = request.cookies
      .getAll()
      .some(
        (cookie) =>
          cookie.value.length > 0 &&
          (cookie.name === platformCookieName || cookie.name.endsWith('_session')),
      );

    if (!hasSessionCookie) {
      /*
       * ════════════════════════════════════════════════════════════════════
       * ★★★ OUR OWN SIGN-IN SCREEN, NOT THE OIDC START
       * ════════════════════════════════════════════════════════════════════
       * This used to redirect to `/api/auth/login`, which begins the OIDC flow
       * immediately and lands on the identity provider's own page. So **no
       * visitor ever reached the sign-in screen this application has** — it was
       * reachable only by typing its URL, and `PUBLIC_PATH_PATTERN` letting
       * `/sign-in` through made it look wired when nothing pointed at it.
       *
       * Omer opened `/v2` and landed on a purple Authentik page. Every walk had
       * navigated straight to `/v2/en/sign-in`, photographed the panel, and
       * reported it working — **entering through a door no user uses.** The
       * screen was never wrong; the route to it did not exist, and no amount of
       * looking at the screen could show that.
       *
       * ★ The extra hop costs nothing: the panel's own Continue button, and its
       *   fallback when the executor cannot be reached, both go to
       *   `/api/auth/login` — which is exactly where this line used to send
       *   people. Nothing is bypassed; something is put in front of it.
       *
       * ── `PLATFORM_LOGIN_URL` STILL WINS ──
       * When it is set, handing off to the platform's own login is a deliberate
       * deployment choice and our panel must not preempt it.
       *
       * ── AND NO LOCALE IS CHOSEN HERE ──
       * `/sign-in` un-prefixed, so `intlMiddleware` negotiates it into
       * `/en/sign-in` or `/he/sign-in` on the next pass. Picking one here would
       * override the visitor's own `Accept-Language` with a guess.
       */
      const platformLogin = process.env.PLATFORM_LOGIN_URL;
      /*
       * ★★ THE MOUNT POINT, FROM THE REQUEST ITSELF.
       *
       * `new URL('/api/auth/login', request.url)` resolves an ABSOLUTE path
       * against the request, which discards the prefix — so under `/v2` this
       * redirected to `/api/auth/login` at the root, which beside the legacy
       * product is another application's login rather than a 404.
       *
       * `nextUrl.basePath` is Next's own value for where this app is mounted,
       * so it is read from the request rather than from an environment
       * variable that could disagree with the build.
       */
      const mount = request.nextUrl.basePath;
      const loginUrl = platformLogin
        ? new URL(platformLogin)
        : new URL(`${mount}/sign-in`, request.url);
      /*
       * `pathname` is already stripped of the prefix by Next, and it is stored
       * that way on purpose: the callback re-prefixes it with `appUrl` when it
       * sends the user back. Carrying an already-prefixed path would produce
       * `/v2/v2/…`.
       *
       * (An earlier draft of this comment said the callback used `redirect()`,
       * which prefixes on its own. It uses `NextResponse.redirect`, which does
       * not — checked, because the difference is the whole behaviour.)
       */
      loginUrl.searchParams.set('returnTo', `${pathname}${request.nextUrl.search}`);

      /*
       * ════════════════════════════════════════════════════════════════════
       * ★★ `no-store`, BECAUSE THIS REDIRECT'S DESTINATION DEPENDS ON STATE
       * ════════════════════════════════════════════════════════════════════
       * Where `/v2` sends somebody is a function of whether they have a
       * session. A stored redirect is a redirect that has stopped asking: a
       * user who signs out can be sent onward by an entry recorded while they
       * were signed in, and a change to this destination — which happened
       * today, in `7801fe7` — can go on being replayed from a browser after
       * the server has moved on.
       *
       * ★ AND THE PRECISE CLAIM, BECAUSE THE LOOSE ONE IS WRONG. A bare 307
       *   is NOT heuristically cacheable: RFC 9111 §4.2.2 lists 200, 203,
       *   204, 206, 300, 301, 308, 404, 405, 410, 414 and 501, and 307 is
       *   absent. So this header is not what fixes a stale redirect somebody
       *   is looking at right now — a browser that replays one is doing it
       *   from its back/forward cache or its in-memory cache for the tab, and
       *   `no-store` is the thing that tells it not to.
       *
       *   Worth stating apart: 404 IS on that list, and `/v2` served a bare
       *   404 before the matcher fix. A browser that saw that one may still
       *   be holding it.
       */
      const redirect = withSecurityHeaders(NextResponse.redirect(loginUrl));
      redirect.headers.set('cache-control', 'no-store');
      return redirect;
    }
  }

  const intlResponse = intlMiddleware(request);

  // A redirect renders no HTML, so there is no nonce to propagate - the
  // response headers are enough.
  const rewriteTarget = intlResponse.headers.get('x-middleware-rewrite');
  if (!rewriteTarget) {
    return withSecurityHeaders(intlResponse);
  }

  /*
   * next-intl decided to rewrite. Re-issuing that rewrite ourselves is the
   * only way to attach the modified REQUEST headers, which is what carries the
   * nonce into the render. next-intl's own headers and cookies are copied
   * across so its locale negotiation is preserved intact.
   */
  const response = NextResponse.rewrite(new URL(rewriteTarget), {
    request: { headers: requestHeaders },
  });

  intlResponse.headers.forEach((value, key) => {
    if (key !== 'x-middleware-rewrite') response.headers.set(key, value);
  });
  for (const cookie of intlResponse.cookies.getAll()) {
    response.cookies.set(cookie);
  }

  return withSecurityHeaders(response);
}

export const config = {
  /*
   * Skip Next internals, the auth and BFF routes (which manage their own
   * authentication), and anything with a file extension.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ★★ THE BARE `'/'` LOOKS REDUNDANT AND IS NOT. DO NOT REMOVE IT.
   * ════════════════════════════════════════════════════════════════════════
   * At the root it IS redundant: `/((?!…).*)` matches `/` with an empty tail,
   * which is why nothing was wrong for months.
   *
   * Under a base path Next prefixes each matcher, so the second entry becomes
   * `/v2/((?!…).*)` — and **`/v2` has no slash after `v2`, so it does not
   * match.** The middleware never ran, nothing redirected the base-path root
   * to a locale, and `/v2` returned a bare 404: the exact URL somebody would
   * type.
   *
   * Verified by building with the prefix and probing. Note which requests
   * carry a session, because the auth gate fires BEFORE locale negotiation and
   * an earlier version of this note conflated the two:
   *
   *   before                     /v2 → 404
   *   after, no session          /v2 → 307 /v2/api/auth/login?returnTo=%2F
   *                              — the same for any Accept-Language, because
   *                                the gate answers first
   *   after, with a session      /v2 → 307 /v2/en
   *                              Accept-Language: he → 307 /v2/he
   *   negotiation on a PUBLIC path, where it is visible unauthenticated:
   *                              /v2/sign-in  he → /v2/he/sign-in
   *                                           en → /v2/en/sign-in
   *                                         none → /v2/en/sign-in
   *   and throughout             /en → 404, so nothing bleeds into the legacy
   *                                namespace
   *
   * ── AND WHY IT IS HERE RATHER THAN IN THE GATEWAY ──
   * nginx could rewrite `/v2` to `/v2/en` and it would be wrong twice: it
   * would put locale policy in the gateway and hardcode a default language
   * for a bilingual product, and the app would still 404 at its own root for
   * anyone arriving another way. Here, next-intl negotiates — a Hebrew
   * browser lands on `/v2/he`.
   */
  matcher: ['/', '/((?!api|_next|_vercel|.*\\..*).*)'],
};
