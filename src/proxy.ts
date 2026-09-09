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
      // Hand off to the platform's own login when configured; otherwise this
      // app's, which drives the OIDC flow itself.
      const platformLogin = process.env.PLATFORM_LOGIN_URL;
      const loginUrl = platformLogin
        ? new URL(platformLogin)
        : new URL('/api/auth/login', request.url);
      loginUrl.searchParams.set('returnTo', `${pathname}${request.nextUrl.search}`);
      return withSecurityHeaders(NextResponse.redirect(loginUrl));
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
   */
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
