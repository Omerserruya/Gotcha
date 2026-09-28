import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The proxy issues the Content-Security-Policy and runs the coarse auth gate,
 * and it had no tests.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WIRING IS THE PART THAT SILENTLY GOES WRONG
 * ════════════════════════════════════════════════════════════════════════════
 * `content-security-policy.ts` is well covered, and a policy nobody applies to
 * the right route is worth nothing. Screen 00a put a password field in our own
 * bundle, so "did the narrower policy actually reach the sign-in page" is now a
 * security question rather than a tidiness one.
 */

/*
 * An async factory with a dynamic import: a `vi.mock` factory is hoisted above
 * the imports, so it cannot close over the `NextResponse` at the top of this
 * file, and `require()` is forbidden here.
 */
vi.mock('next-intl/middleware', async () => {
  const { NextResponse: Response } = await import('next/server');
  return { default: () => () => Response.next() };
});

const { default: proxy } = await import('./proxy');

const cspFor = (path: string): string => {
  const response = proxy(new NextRequest(`https://dev.gotcha.co.il${path}`));
  return response.headers.get('content-security-policy') ?? '';
};

const directive = (csp: string, name: string): string[] => {
  const found = csp
    .split('; ')
    .map((part) => part.split(' '))
    .find((parts) => parts[0] === name);
  return found ? found.slice(1) : [];
};

describe('⚠⚠ an unauthenticated visitor reaches OUR sign-in screen', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * THE DESTINATION IS THE ASSERTION. "IT REDIRECTS" PASSED WITH THE WRONG ONE.
   * ════════════════════════════════════════════════════════════════════════════
   * The gate used to send visitors to `/api/auth/login`, which starts the OIDC
   * flow immediately and lands on the identity provider's own page. **So nobody
   * ever saw the sign-in screen this application has.** It was reachable only by
   * typing its URL — and every walk did exactly that, photographed the panel, and
   * reported it working.
   *
   * A test for "an unauthenticated request redirects" would have passed
   * throughout. These assert where to.
   */
  const redirectFor = (path: string, cookie?: string) => {
    const request = new NextRequest(`https://dev.gotcha.co.il${path}`, {
      headers: cookie ? { cookie } : undefined,
    });
    const response = proxy(request);
    return { status: response.status, location: response.headers.get('location') ?? '' };
  };

  it('⚠⚠ sends them to /sign-in, not to the OIDC start', () => {
    const { status, location } = redirectFor('/en/home');
    expect(status).toBe(307);
    expect(location).toContain('/sign-in');
    expect(location).not.toContain('/api/auth/login');
  });

  it('⚠⚠ carries `returnTo`, or "back to where you were" is broken', () => {
    /*
     * The design requires that signing in returns somebody to the exact
     * conversation they were reading. That round trip now has an extra hop — the
     * panel — and `returnTo` has to survive it, because the panel appends it to
     * the `/api/auth/login` it eventually calls.
     */
    const { location } = redirectFor('/en/inbox?c=abc');
    const target = new URL(location, 'https://dev.gotcha.co.il');
    expect(target.searchParams.get('returnTo')).toBe('/en/inbox?c=abc');
  });

  it('★ chooses no locale, leaving negotiation to next-intl', () => {
    /*
     * `/sign-in` un-prefixed. Picking `/en/sign-in` here would override the
     * visitor's own `Accept-Language` with a guess, on the first page they see.
     */
    const { location } = redirectFor('/en/home');
    const target = new URL(location, 'https://dev.gotcha.co.il');
    expect(target.pathname).toBe('/sign-in');
  });

  it('★★ does not redirect the sign-in screen itself', () => {
    // The obvious way to turn this fix into an infinite loop.
    const { status } = redirectFor('/en/sign-in');
    expect(status).not.toBe(307);
  });

  it('★★ leaves a visitor who already has a session alone', () => {
    /*
     * Both directions. A gate that redirected everybody would "pass" every test
     * above and lock out every signed-in user.
     *
     * ★ This app's cookie is `gotcha_session`, and the gate matches on
     *   `endsWith('_session')`. The first version of this test used
     *   `gotcha_session_dev` — the LEGACY product's name, which ends in `_dev`
     *   and does not match. My fixture was wrong, not the gate; noted because it
     *   is the same prefix-versus-suffix trap that has cost two wrong readings
     *   today.
     */
    const { status } = redirectFor('/en/home', 'gotcha_session=abc123');
    expect(status).not.toBe(307);
  });

  it('⚠⚠ the redirect is never stored, because its destination is state', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A CACHED REDIRECT IS A REDIRECT THAT HAS STOPPED ASKING
     * ════════════════════════════════════════════════════════════════════════
     * Where `/v2` sends somebody depends on whether they have a session. A
     * stored copy sends a signed-out user onward by an entry recorded while
     * they were signed in — and when this destination changed today, browsers
     * went on replaying the old one for an hour after the server had moved.
     *
     * ★ The precise claim, because the loose one is wrong: a bare 307 is NOT
     *   heuristically cacheable — RFC 9111 §4.2.2 lists 200, 203, 204, 206,
     *   300, 301, 308, 404, 405, 410, 414, 501, and 307 is absent. This header
     *   speaks to the browser's own back/forward and in-memory caches, which
     *   obey `no-store` and do not consult that list.
     */
    const request = new NextRequest('https://dev.gotcha.co.il/en/home');
    expect(proxy(request).headers.get('cache-control')).toBe('no-store');
  });

  it('★ and an ordinary page is NOT marked no-store', () => {
    /*
     * Both directions. Stamping every response would make the whole product
     * uncacheable to fix one redirect, and nothing on the screen would say so.
     */
    const signedIn = new NextRequest('https://dev.gotcha.co.il/en/home', {
      headers: { cookie: 'gotcha_session=abc123' },
    });
    expect(proxy(signedIn).headers.get('cache-control')).not.toBe('no-store');
  });

  it('★★ an empty session cookie is not a session', () => {
    /*
     * A cleared cookie is sent as an empty value rather than withdrawn. Treating
     * its presence as a session would leave somebody staring at a shell that
     * 401s on every read, with no route to sign in again.
     */
    const { status, location } = redirectFor('/en/home', 'gotcha_session=');
    expect(status).toBe(307);
    expect(location).toContain('/sign-in');
  });
});

describe('★★ the narrower policy reaches the page that has a password on it', () => {
  it('★★ sign-in gets no `https:` image wildcard', () => {
    expect(directive(cspFor('/en/sign-in'), 'img-src')).toEqual(["'self'", 'data:']);
  });

  it('★★ and every other page keeps it, or avatars break', () => {
    /*
     * Both directions. A narrowing that leaked into the product would stop
     * customer photos loading and read as a backend failure — and a test that
     * only checked sign-in could not tell the two apart.
     */
    expect(directive(cspFor('/en/home'), 'img-src')).toContain('https:');
    expect(directive(cspFor('/en/inbox'), 'img-src')).toContain('https:');
  });

  it('★★ matches sign-in with and without a locale, and with a trailing slash', () => {
    /*
     * The pattern decides both the auth gate and now the policy. A locale it does
     * not match would be a sign-in page that is ALSO treated as private — an
     * infinite redirect — so this list is not cosmetic.
     */
    for (const path of ['/sign-in', '/en/sign-in', '/he/sign-in', '/en/sign-in/']) {
      expect(directive(cspFor(path), 'img-src'), path).toEqual(["'self'", 'data:']);
    }
  });

  it('★★ does not match a path that merely starts with the same letters', () => {
    /*
     * `/sign-in-help` is not the sign-in page. A prefix match here would hand a
     * narrower policy to an unrelated route — and, through the same pattern,
     * make it public. Prefix collisions have already cost a wrong count on the
     * security screen this week.
     */
    expect(directive(cspFor('/en/sign-in-help'), 'img-src')).toContain('https:');
  });

  it('★ every response carries a nonce, and a different one each time', () => {
    // A reused nonce is no better than `unsafe-inline`.
    const first = cspFor('/en/home');
    const second = cspFor('/en/home');
    expect(first).toMatch(/'nonce-[^']+'/);
    expect(first).not.toBe(second);
  });
});
