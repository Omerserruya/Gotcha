import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route handlers that must not answer on the sign-in origin.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ `proxy.ts` CANNOT REFUSE THESE. ITS MATCHER EXCLUDES `/api`.
 * ════════════════════════════════════════════════════════════════════════════
 * The credential-surface refusal in the middleware 404s every product route on
 * the auth origin — and **middleware never runs for a route handler**:
 *
 *     matcher: ['/', '/((?!api|_next|_vercel|.*\\..*).*)']
 *                        ^^^
 *
 * So `/api/bff/…`, which forwards the caller's platform session upstream, was
 * covered on that origin by the gateway allowlist **and by nothing else** —
 * while every page route had two independent refusals. The guard I wrote read
 * as covering the app; it covered the part of the app its matcher could see.
 *
 * ★ That is the same defect as the sweep organised by file: a check that is
 *   correct about everything it examines, and silent about what it does not.
 *
 * ── WHY 404 AND NOT 403 ──
 * The auth origin's answer to a product route is "there is nothing here",
 * which is true: this build serves one screen. A 403 would say "there is
 * something here and you may not have it", which is both less true and more
 * informative to somebody probing.
 */

/**
 * Refuses when this build is the sign-in origin, otherwise returns null.
 *
 * `PRODUCT_LOGIN_URL` is the same signal the middleware uses — it tells this
 * build where the product is, which is only ever true of a build that is not
 * the product. One variable, so the two refusals cannot disagree about which
 * deployment they are running in.
 */
export function refuseOnCredentialSurface(request: NextRequest): NextResponse | null {
  if (!process.env.PRODUCT_LOGIN_URL) return null;
  void request;
  const response = new NextResponse(null, { status: 404 });
  // The same reason the middleware's refusal is not stored: this answer is
  // about which deployment is running, and a browser holding it across a
  // configuration change would be answering for the wrong one.
  response.headers.set('cache-control', 'no-store');
  return response;
}
