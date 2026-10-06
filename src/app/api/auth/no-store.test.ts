import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * No answer from an auth route may be stored by a browser.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS IS A PROPERTY OF THE SET, WHICH NO UNIT TEST CAN SEE
 * ════════════════════════════════════════════════════════════════════════════
 * The callback answers six ways - five refusals and one success - and each
 * carries either a single-use reason or a `Set-Cookie` with a sealed session.
 * A test that drove one of them and checked its header would pass while a
 * seventh was added without the wrapper, which is the way this actually goes
 * wrong: not a header written incorrectly, a return statement added later.
 *
 * So it asserts the shape of the source - every `NextResponse.redirect` in
 * these handlers is inside `uncached(…)` - rather than the behaviour of one
 * path. The same reason `messages.test.ts` reads the directory instead of
 * trusting a list.
 *
 * ★ These handlers have no unit tests at all: they need the OIDC client, the
 *   environment and a live `Set-Cookie` to exercise. That is a real gap, and
 *   this narrows it to the one property most likely to rot rather than
 *   pretending to close it.
 */

/** Every auth route that answers with a redirect. */
const ROUTES = ['src/app/api/auth/callback/route.ts', 'src/app/api/auth/login/route.ts'] as const;

/**
 * The ones that RETURN a redirect expression, which is the form the wrapper
 * scan below can see.
 *
 * ★ The login route is deliberately absent: it assigns its redirect to a name
 *   so it can attach the sealed PKCE cookie, so the scan finds nothing there.
 *   Its tripwire fired on the first run of this file and it was right to -
 *   "no redirects found" is what a broken scan and a differently-shaped file
 *   look like alike, and the answer is to say which this is rather than to
 *   loosen the regex until it matches something.
 */
const RETURNING_ROUTES = ['src/app/api/auth/callback/route.ts'] as const;

describe('⚠⚠ every auth redirect says no-store', () => {
  it('⚠⚠ no `NextResponse.redirect` escapes the wrapper', () => {
    for (const route of RETURNING_ROUTES) {
      const source = readFileSync(route, 'utf8');
      const returned = [...source.matchAll(/return\s+([A-Za-z]+\()?NextResponse\.redirect/g)];
      expect(returned.length, `${route}: no redirects found - the scan is broken`).toBeGreaterThan(
        0,
      );
      for (const match of returned) {
        // Either wrapped at the return, or assigned and wrapped on the way out.
        expect(match[1] ?? 'unwrapped', route).toBe('uncached(');
      }
    }
  });

  it('★ and the value is the one that stops a back/forward replay', () => {
    /*
     * `no-cache` would be the wrong one: it permits storing and requires
     * revalidation, and the back/forward cache does not revalidate. Only
     * `no-store` keeps the response out of it.
     */
    for (const route of ROUTES) {
      const source = readFileSync(route, 'utf8');
      expect(source, route).toContain("'cache-control', 'no-store'");
      expect(source, route).not.toContain("'cache-control', 'no-cache'");
    }
  });

  it('★★ the login route assigns its redirect, so the wrapper is not the only rule', () => {
    /*
     * It sets the sealed PKCE cookie on a named response rather than returning
     * the redirect directly, so the scan above cannot see it. Named here so
     * that "every redirect is wrapped" is not quietly true because one of them
     * is not a redirect the regex recognises.
     */
    const source = readFileSync('src/app/api/auth/login/route.ts', 'utf8');
    expect(source).toContain('const response = NextResponse.redirect(');
    expect(source).toContain("response.headers.set('cache-control', 'no-store')");
  });
});
