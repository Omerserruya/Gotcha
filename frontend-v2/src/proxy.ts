import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { routing } from '@/i18n/routing';
import {
  buildContentSecurityPolicy,
  generateNonce,
  NONCE_HEADER,
} from '@/observability/content-security-policy';

import { refreshSession } from '@/auth/refresh';
import { RETURN_TO_HEADER, SESSION_ENDED_HEADER } from '@/auth/return-to';
import { nowInSeconds, sealSession, sessionCookieOptions, unsealSession } from '@/auth/session';

import { PUBLIC_PATH_PATTERN, SIGNED_OUT_PATH_PATTERN } from './auth-surface';
import { isLocale } from '@/i18n/locales';
import { inLocaleOf, mountOf } from '@/auth/sign-in-url';
import { legacyLocale, legacyRedirect } from '@/i18n/legacy-redirect';

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

/**
 * What the session renewal decided before the gate ran.
 *
 *   kept     nothing to do (no session cookie, a public path, or a token with
 *            time left)
 *   renewed  refreshed here: `sealed` replaces the cookie - on the response,
 *            so the browser keeps the new refresh token, and on the forwarded
 *            request, so this very render uses the new access token
 *   ended    the identity provider refused the refresh: the cookie is cleared
 *            and the visitor goes to sign-in, never to a screen of "couldn't
 *            read" states
 */
type CookieAttributes = Omit<ReturnType<typeof sessionCookieOptions>, 'name'>;

export type Renewal =
  | { readonly kind: 'kept' }
  | {
      readonly kind: 'renewed';
      readonly name: string;
      readonly sealed: string;
      readonly attributes: CookieAttributes;
    }
  | { readonly kind: 'ended'; readonly name: string; readonly attributes: CookieAttributes };

/**
 * Refresh this far ahead of expiry. Wider than `activeSession`'s 60 seconds
 * on purpose: a page navigation renews before a route handler would, so the
 * two rarely race for the same rotating refresh token.
 */
export const RENEW_AHEAD_SECONDS = 300;

/**
 * ★★ WHERE THE SESSION IS RENEWED, AND WHY HERE.
 * Authentik rotates refresh tokens, so a refresh that is not persisted ends
 * the session. A Server Component cannot write a cookie; the proxy can - on
 * the response for the browser, and on the request for the render that
 * follows. See `src/auth/refresh.ts`.
 */
export async function renew(request: NextRequest): Promise<Renewal> {
  if (PUBLIC_PATH_PATTERN.test(request.nextUrl.pathname)) return { kind: 'kept' };
  const { name, ...attributes } = sessionCookieOptions();
  const session = await unsealSession(request.cookies.get(name)?.value);
  if (!session || session.exp - RENEW_AHEAD_SECONDS > nowInSeconds()) return { kind: 'kept' };
  const refreshed = await refreshSession(session);
  if (!refreshed) return { kind: 'ended', name, attributes };
  return { kind: 'renewed', name, sealed: await sealSession(refreshed), attributes };
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  return legacy(request) ?? gate(request, await renew(request));
}

/**
 * A link to the old app (2026-10-21: this app replaced it at the root) goes to
 * its screen here - see `i18n/legacy-redirect.ts` for the table.
 *
 * ★ FIRST, BEFORE `renew`. A redirect returned after a renewal would drop the
 *   renewed cookie, and a refresh that rotated the token would then leave the
 *   visitor holding a spent one. Before the gate, too, so a signed-out
 *   visitor's `returnTo` names the new path, not the old.
 *
 * 302 while the table is young: a permanent redirect is cached by browsers
 * and outlives a corrected row.
 */
export function legacy(request: NextRequest): NextResponse | null {
  const target = legacyRedirect(request.nextUrl, legacyLocale(request.cookies));
  if (!target) return null;
  const to = /^https?:\/\//.test(target)
    ? target
    : new URL(`${request.nextUrl.basePath}${target}`, request.nextUrl.origin).toString();
  const response = NextResponse.redirect(to, 302);
  response.headers.set('cache-control', 'no-store');
  return response;
}

/** Locale, the coarse gate and the CSP - after `renew` has run. */
export function gate(request: NextRequest, renewal: Renewal = { kind: 'kept' }): NextResponse {
  const { pathname } = request.nextUrl;

  /*
    The render reads the session from the REQUEST's cookies: give it the
    renewed one, or none - before anything copies the request's headers.
  */
  if (renewal.kind === 'renewed') request.cookies.set(renewal.name, renewal.sealed);
  else if (renewal.kind === 'ended') request.cookies.delete(renewal.name);

  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    realtimeUrl: process.env.NEXT_PUBLIC_REALTIME_URL,
    isDevelopment: process.env.NODE_ENV !== 'production',
    /*
     * ★★ THE SIGN-IN ROUTE NOW HOLDS A PASSWORD FIELD IN OUR OWN BUNDLE.
     * Until screen 00a, the credential was typed on the identity provider's
     * origin and an injected script here could not reach it. It narrows
     * `img-src`, `media-src`, `connect-src` and `frame-src` - the ways a value
     * leaves a page - on exactly the route that has one to lose.
     *
     * The same pattern already decides which routes are public, and it is reused
     * rather than copied: two lists of "which pages are the sign-in" would be
     * one list too many, and the one that drifts would be this one.
     */
    credentialSurface: PUBLIC_PATH_PATTERN.test(pathname),
    // 13c: Meta's Embedded Signup frames facebook.com - on the channels pages only.
    metaSignupSurface: META_SIGNUP_PATH.test(pathname),
  });

  /*
   * The nonce must reach the render, and Next.js reads it from the
   * `content-security-policy` REQUEST header - that is what makes it stamp its
   * own bootstrap scripts. So the header goes on the request as well as the
   * response, and `x-nonce` is carried alongside for our own inline script.
   */
  const requestHeaders = new Headers(request.headers);
  // Ended at the identity provider, not merely absent: a render that sends
  // them to sign-in says so (`signInHere`). Never trusted from the browser.
  requestHeaders.delete(SESSION_ENDED_HEADER);
  if (renewal.kind === 'ended') requestHeaders.set(SESSION_ENDED_HEADER, '1');
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('content-security-policy', csp);
  /*
    Where the visitor is, without the mount (`nextUrl` has none) - so the
    layout can send someone signed out back here after sign-in.
  */
  requestHeaders.set(RETURN_TO_HEADER, `${pathname}${request.nextUrl.search}`);

  const withSecurityHeaders = (response: NextResponse): NextResponse => {
    response.headers.set('content-security-policy', csp);
    response.headers.set(NONCE_HEADER, nonce);
    // Every way out carries the renewal: the browser must keep the new token.
    if (renewal.kind === 'renewed') {
      response.cookies.set(renewal.name, renewal.sealed, renewal.attributes);
    } else if (renewal.kind === 'ended') {
      response.cookies.set(renewal.name, '', { ...renewal.attributes, maxAge: 0 });
    }
    return response;
  };

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * ★★ ON THE AUTH ORIGIN, THIS BUILD SERVES SIGN-IN AND NOTHING ELSE
   * ═══════════════════════════════════════════════════════════════════════════
   * A root-mounted build of this source compiles EVERY route, so an auth host
   * that serves it has the whole product available behind a gateway allowlist.
   * That allowlist is a real security control and it was wrong on its first
   * version - it permitted `/sign-in`, the app answered 307 to `/en/sign-in`,
   * and the screen 404’d behind a redirect that looked fine. One rule, one
   * place, one mistake away.
   *
   * ★★ AND IT IS DERIVED, NOT DECLARED. There is no `IS_AUTH_ORIGIN` flag,
   *   because a boolean whose wrong value is a TOTAL OUTAGE is a new way to
   *   take the product down, sitting in a compose file beside a dozen that do
   *   nothing of the sort. `PRODUCT_LOGIN_URL` already means exactly "I am the
   *   sign-in origin": it tells this build where the product is, which is only
   *   ever true of a build that is not the product.
   *
   *   So the dangerous combination is unconstructible rather than documented.
   *   To 404 the product you would have to tell the product where the product
   *   is. And the two facts cannot drift: a build that hands over to the
   *   product IS a build that should serve nothing but sign-in, and with a
   *   separate flag those would be two assertions free to disagree.
   *
   * ★ A BARE 404, NOT THE PRODUCT’S NOT-FOUND PAGE. Rendering that here would
   *   ship the product’s chrome and its vocabulary to the origin whose entire
   *   purpose is to carry neither - the same mistake as the translation
   *   catalogue, one layer out. An empty refusal is the correct body.
   */
  const signInElsewhere = process.env.SIGN_IN_URL;

  if (process.env.PRODUCT_LOGIN_URL && !PUBLIC_PATH_PATTERN.test(pathname)) {
    return withSecurityHeaders(new NextResponse(null, { status: 404 }));
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * ★★ AND THE MIRROR: ONCE SIGN-IN HAS MOVED, THIS ORIGIN STOPS SERVING IT
   * ═══════════════════════════════════════════════════════════════════════════
   * Pointing the gate at another origin RELOCATES the panel; it does not remove
   * this one. `/v2/en/sign-in` would go on rendering a password field, working
   * perfectly, reachable by bookmark, by an old link, or by the callback's own
   * error redirect - **on the origin the move exists to get the password off.**
   *
   * ★ That origin is measured to allow `'unsafe-inline' 'unsafe-eval'` and a
   *   third-party script host. Moving the panel to a clean origin while leaving
   *   a working copy on the dirty one collects none of the benefit and keeps
   *   every cost: it is the same defect as an orphaned route, inverted - not a
   *   screen nothing points at, but a screen that still answers after
   *   everything stopped pointing at it.
   *
   * ★ The query is carried whole rather than named field by field. `returnTo`
   *   and `error` both arrive here - the callback sends `?error=expired` to
   *   THIS path - and a list of the parameters we thought of is the shape that
   *   drops the next one silently.
   *
   * ⚠ A SAME-ORIGIN TARGET IS IGNORED, BECAUSE IT IS AN INFINITE LOOP ON THE
   *   FRONT DOOR. `SIGN_IN_URL` naming this host would send `/sign-in` to
   *   itself, or to a form `intlMiddleware` bounces straight back. The whole
   *   point of the variable is another origin, so a value that is not one is a
   *   misconfiguration, and the safe reading of it is today's behaviour rather
   *   than a redirect chain nobody can escape.
   *
   * ★★ AND IT ASKS TWO SOURCES FOR "THIS HOST", BECAUSE ONE OF THEM IS THE
   *   CONNECTION'S AND NOT THE VISITOR'S. Measured against the built image:
   *   `nextUrl.host` is the host the request ARRIVED on and **ignores
   *   `x-forwarded-host` entirely** - a probe reaching the container directly
   *   saw `127.0.0.1:3999` and a redirect emitted to `127.0.0.1:3996`.
   *
   *   Behind the gateway that is usually the public host, because nginx passes
   *   `Host` through. "Usually" is not a property to rest a loop guard on, so
   *   the forwarded header is consulted as well and either match is enough.
   *
   * ★ Worth being exact about which way this fails. If `nextUrl.host` is the
   *   INTERNAL host and the forwarded header is absent, the comparison cannot
   *   match and the guard does not fire - but the only configuration that
   *   reaches it is one where `SIGN_IN_URL` names this same product, which is
   *   already broken. **A wrong host weakens the loop guard; it never breaks
   *   the correct configuration**, where the target is a different origin and
   *   the redirect must happen.
   */
  if (signInElsewhere && !process.env.PRODUCT_LOGIN_URL && PUBLIC_PATH_PATTERN.test(pathname)) {
    const moved = new URL(signInElsewhere);
    const hostsHere = new Set(
      [request.nextUrl.host, request.headers.get('x-forwarded-host')].filter(Boolean),
    );
    if (!hostsHere.has(moved.host)) {
      // The same screen, in the language the URL picked: `/he/recover` stays
      // `/he/recover` there. Only a path with no language is left to
      // Accept-Language (dev: /v2/he/sign-in landed on /en/sign-in).
      moved.pathname = `${mountOf(moved)}${pathname}`;
      for (const [key, value] of request.nextUrl.searchParams) {
        moved.searchParams.set(key, value);
      }
      const relocated = withSecurityHeaders(NextResponse.redirect(moved));
      relocated.headers.set('cache-control', 'no-store');
      return relocated;
    }
  }

  /*
   * ★ An emailed link's page (an invitation, an expired setup link, checkout)
   *   is opened by somebody who cannot sign in yet. It skips this redirect and
   *   nothing else - see `SIGNED_OUT_ROUTES` for why it is not the sign-in
   *   surface's pattern.
   */
  if (!PUBLIC_PATH_PATTERN.test(pathname) && !SIGNED_OUT_PATH_PATTERN.test(pathname)) {
    /*
     * Either session counts. This is a redirect, not a security control - it
     * only avoids rendering a shell that is about to 401, and the real check
     * happens where the data is.
     */
    const platformCookieName = process.env.PLATFORM_SESSION_COOKIE;
    // An ended session's cookie was already taken off the request above.
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
       * visitor ever reached the sign-in screen this application has** - it was
       * reachable only by typing its URL, and `PUBLIC_PATH_PATTERN` letting
       * `/sign-in` through made it look wired when nothing pointed at it.
       *
       * Omer opened `/v2` and landed on a purple Authentik page. Every walk had
       * navigated straight to `/v2/en/sign-in`, photographed the panel, and
       * reported it working - **entering through a door no user uses.** The
       * screen was never wrong; the route to it did not exist, and no amount of
       * looking at the screen could show that.
       *
       * ★ The extra hop costs nothing: the panel's own Continue button, and its
       *   fallback when the executor cannot be reached, both go to
       *   `/api/auth/login` - which is exactly where this line used to send
       *   people. Nothing is bypassed; something is put in front of it.
       *
       * ── `PLATFORM_LOGIN_URL` STILL WINS ──
       * When it is set, handing off to the platform's own login is a deliberate
       * deployment choice and our panel must not preempt it.
       *
       * ── ★★ AND `SIGN_IN_URL` IS THE SAME SCREEN, SOMEWHERE ELSE ──
       * Once sign-in is served from its own origin, our panel is still the
       * destination - it is simply not on this host. That is a different fact
       * from `PLATFORM_LOGIN_URL`, which means "do not use our panel at all",
       * so it gets its own variable rather than borrowing one whose meaning is
       * the opposite.
       *
       * ★ It is the symmetric twin of `PRODUCT_LOGIN_URL`: each build is told
       *   where the OTHER one is, and neither is a boolean. The product points
       *   at the sign-in origin; the sign-in origin points at the product.
       *   Absent on both, they are the same deployment and nothing changes.
       *
       * ★ A whole URL, not an origin, for the reason `PRODUCT_LOGIN_URL` is:
       *   composing one would need the other build's mount point, which this
       *   build does not have and must not guess.
       *
       * ── ★★ THE LANGUAGE IN THE URL WINS ──
       * It used to be dropped here on purpose - `/sign-in` un-prefixed, for
       * `Accept-Language` to decide on the next pass. But a language in the
       * path is one the visitor PICKED, and an en-US browser on `/he/inbox`
       * was signed in in English (dev, 2026-10-07). So the path's language
       * carries over - to our screen and to `SIGN_IN_URL`'s - and only a
       * path with none is left to `Accept-Language`. `PLATFORM_LOGIN_URL`
       * is someone else's page and is used exactly as given.
       */
      const platformLogin = process.env.PLATFORM_LOGIN_URL;
      /*
       * ★★ THE MOUNT POINT, FROM THE REQUEST ITSELF.
       *
       * `new URL('/api/auth/login', request.url)` resolves an ABSOLUTE path
       * against the request, which discards the prefix - so under `/v2` this
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
        : signInElsewhere
          ? inLocaleOf(new URL(signInElsewhere), pathname, isLocale)
          : inLocaleOf(new URL(`${mount}/sign-in`, request.url), pathname, isLocale);
      /*
       * `pathname` is already stripped of the prefix by Next, and it is stored
       * that way on purpose: the callback re-prefixes it with `appUrl` when it
       * sends the user back. Carrying an already-prefixed path would produce
       * `/v2/v2/…`.
       *
       * (An earlier draft of this comment said the callback used `redirect()`,
       * which prefixes on its own. It uses `NextResponse.redirect`, which does
       * not - checked, because the difference is the whole behaviour.)
       */
      loginUrl.searchParams.set('returnTo', `${pathname}${request.nextUrl.search}`);
      // Ended here, at the identity provider: our screen says so - never a
      // silent sign-in page, or a list that "couldn't read" behind it.
      if (renewal.kind === 'ended' && !platformLogin) loginUrl.searchParams.set('error', 'ended');

      /*
       * ════════════════════════════════════════════════════════════════════
       * ★★ `no-store`, BECAUSE THIS REDIRECT'S DESTINATION DEPENDS ON STATE
       * ════════════════════════════════════════════════════════════════════
       * Where `/v2` sends somebody is a function of whether they have a
       * session. A stored redirect is a redirect that has stopped asking: a
       * user who signs out can be sent onward by an entry recorded while they
       * were signed in, and a change to this destination - which happened
       * today, in `7801fe7` - can go on being replayed from a browser after
       * the server has moved on.
       *
       * ★ AND THE PRECISE CLAIM, BECAUSE THE LOOSE ONE IS WRONG. A bare 307
       *   is NOT heuristically cacheable: RFC 9111 §4.2.2 lists 200, 203,
       *   204, 206, 300, 301, 308, 404, 405, 410, 414 and 501, and 307 is
       *   absent. So this header is not what fixes a stale redirect somebody
       *   is looking at right now - a browser that replays one is doing it
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

  /*
   * A redirect renders nothing: its own headers are enough. Otherwise next-intl
   * either rewrites or passes through (`localePrefix: 'always'` passes through
   * every already-prefixed path) - and BOTH carry the request headers it built
   * from the original request. Re-issued here with ours, which carry the
   * nonce, where the visitor is, and the renewed session cookie: forwarding
   * next-intl's would hand the render the spent refresh token.
   */
  const rewriteTarget = intlResponse.headers.get('x-middleware-rewrite');
  const passesThrough = intlResponse.headers.get('x-middleware-next') === '1';
  if (!rewriteTarget && !passesThrough) {
    return withSecurityHeaders(intlResponse);
  }

  // next-intl's own request header - the locale it resolved - rides along.
  const locale = intlResponse.headers.get(`x-middleware-request-${INTL_LOCALE_HEADER}`);
  if (locale) requestHeaders.set(INTL_LOCALE_HEADER, locale);

  const response = rewriteTarget
    ? NextResponse.rewrite(new URL(rewriteTarget), { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });

  intlResponse.headers.forEach((value, key) => {
    if (FORWARDING_HEADERS.test(key)) return;
    response.headers.set(key, value);
  });
  for (const cookie of intlResponse.cookies.getAll()) {
    response.cookies.set(cookie);
  }

  return withSecurityHeaders(response);
}

/** Where 13c's Meta launcher runs: Settings · Channels, in any locale. */
export const META_SIGNUP_PATH = /^\/[a-z]{2}\/settings\/channels(\/|$)/;

/** next-intl's request header for the resolved locale. */
const INTL_LOCALE_HEADER = 'x-next-intl-locale';
/** How a proxy response says what to forward - ours, never next-intl's copy. */
const FORWARDING_HEADERS =
  /^x-middleware-(rewrite|next|override-headers|request-.*)$|^set-cookie$/i;

export const config = {
  /*
   * Skip Next internals, the auth and BFF routes (which manage their own
   * authentication), and static assets.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ★★ IT USED TO SKIP ANY PATH WITH A DOT IN IT, AND THAT WAS A HOLE
   * ═══════════════════════════════════════════════════════════════════════════
   * `.*\..*` was meant to mean "a static file". It means "a dot anywhere", and
   * two routes here take an id. Reproduced against the deployed auth image:
   *
   *     /en/home                   404   refused
   *     /en/customers/plain        404   refused
   *     /en/customers/a.b@c.com    307   ★ skipped the middleware entirely
   *
   * Everything in this file was skipped with it - the credential-surface
   * refusal, the auth gate, and the narrowed CSP. On the sign-in origin that
   * left the gateway allowlist as the ONLY guard on that shape, while every
   * other product path had two.
   *
   * ★ `/en/settings/…/roles/u.1` looks like a second witness and is not: it has
   *   no route, so Next refuses it for an unrelated reason. **One live example,
   *   not two** - worth stating, because a hole with two witnesses and a hole
   *   with one get triaged differently.
   *
   * ── WHY AN EXTENSION LIST RATHER THAN A NARROWER DOT RULE ──
   * "Ends with a dot and letters" does not work: an id like `a.b@c.com` ends
   * in `.com`. Only naming the extensions separates a static asset from a path
   * segment that happens to contain a dot.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠⚠ AND THE `$` IS THE WHOLE RULE. WITHOUT IT THE LIST SHRANK THE HOLE
   *    RATHER THAN CLOSING IT.
   * ═══════════════════════════════════════════════════════════════════════════
   * A lookahead does not have to reach the end of the string. Unanchored,
   * `.*\.(?:…|js|…)` means "a dot followed by something that **begins with** a
   * listed extension", so the trailing `.*` eats the rest:
   *
   *     a.b@c.com        ran      ✓   the case the list was written for
   *     a.jsmith@c.com   SKIPPED  ⚠   `.js` + `mith`
   *     a.mapleton@c.com SKIPPED  ⚠   `.map` + `leton`
   *     a.txtra@c.com    SKIPPED  ⚠   `.txt` + `ra`
   *     q.icourt@c.com   SKIPPED  ⚠   `.ico` + `urt`
   *
   * ★★ `a.jsmith@company.com` is what "J. Smith" looks like. Not a contrived
   *   probe - one of the likeliest strings in that column.
   *
   * ★ My own probes missed it because every one of them had a dot followed by
   *   something that starts no extension: `a.b`, `v1.2`, `u.1`. **The probe set
   *   was built from the shapes I had already seen**, which is the failure this
   *   file documents three times over, and it caught the fix for it.
   *
   * ★ The anchored form is also what Next's own guide shows -
   *   `'/((?!api|_next/static|_next/image|.*\.png$).*)'` - so the unanchored
   *   version was not a variant of the documented pattern, it was a mistake
   *   against it. Matcher paths carry no query string, so `$` is the end of
   *   the path.
   *
   * ★ And `public/` holds nothing but `.gitkeep` - measured, not assumed - so
   *   this exclusion currently protects no file that exists. It is kept narrow
   *   rather than removed because the day somebody adds `favicon.ico` should
   *   not be the day the auth gate starts redirecting it.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ★★ THE BARE `'/'` LOOKS REDUNDANT AND IS NOT. DO NOT REMOVE IT.
   * ════════════════════════════════════════════════════════════════════════
   * At the root it IS redundant: `/((?!…).*)` matches `/` with an empty tail,
   * which is why nothing was wrong for months.
   *
   * Under a base path Next prefixes each matcher, so the second entry becomes
   * `/v2/((?!…).*)` - and **`/v2` has no slash after `v2`, so it does not
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
   *                              - the same for any Accept-Language, because
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
   * anyone arriving another way. Here, next-intl negotiates - a Hebrew
   * browser lands on `/v2/he`.
   */
  matcher: [
    '/',
    '/((?!api|_next|_vercel|.*\\.(?:ico|png|jpe?g|gif|svg|webp|avif|css|js|mjs|map|txt|xml|webmanifest|woff2?|ttf|otf|eot|pdf)$).*)',
  ],
};
