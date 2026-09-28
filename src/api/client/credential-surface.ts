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
 *     matcher: ['/', '/((?!api|_next|_vercel|.*\\.(?:ico|png|…)).*)']
 *                        ^^^
 *
 * (Quoted in part, and quoting it at all is a small risk: the `.*\\..*` this
 * once read was corrected in `4f719de` and three copies of it — here and twice
 * in `docs/base-path-audit.md` — all had to be found by grep. The `/api`
 * exclusion is the load-bearing part for this file, and it has not changed.)
 *
 * So `/api/bff/…`, which forwards the caller's platform session upstream, was
 * covered on that origin by the gateway allowlist **and by nothing else** —
 * while every page route had two independent refusals. The guard I wrote read
 * as covering the app; it covered the part of the app its matcher could see.
 *
 * ★ That is the same defect as the sweep organised by file: a check that is
 *   correct about everything it examines, and silent about what it does not.
 *
 * ⚠⚠ AND THE SAME MATCHER SKIPS ANY PATH CONTAINING A DOT — `.*\..*` — so
 *   "the middleware covers every page route" is ALSO not true. Measured:
 *
 *       /en/home                    middleware runs
 *       /en/customers/a.b@c.com     middleware SKIPPED
 *       /en/settings/.../roles/u.1  middleware SKIPPED
 *
 *   Two dynamic routes take an id. If one ever carries a dot, that page skips
 *   the credential-surface refusal, the auth gate AND the narrowed CSP.
 *
 *   It is latent rather than live, and the reason is worth naming because
 *   nothing else names it: **this app's session cookie sets no `domain`, so it
 *   is host-only and never reaches the sign-in origin.** Without a session the
 *   layout redirects to `/api/auth/login`, which this guard refuses. Give that
 *   cookie a `domain` — to share it across subdomains, which is a reasonable
 *   thing somebody might do — and a signed-in visitor renders a product page
 *   on the auth origin. Recorded at `sessionCookieOptions` as well.
 *
 *   Not closed with a third mechanism here: the gateway allowlist blocks these
 *   paths, and the obvious fix — `notFound()` in the product layout — renders
 *   the PRODUCT's not-found page, shipping its chrome and its link to `/home`
 *   to the origin whose purpose is to carry neither. The gap is asserted in
 *   the test beside this file rather than described only here.
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
