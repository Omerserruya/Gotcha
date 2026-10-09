import { readFileSync } from 'node:fs';

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

const { gate: proxy } = await import('./proxy');

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
   * typing its URL - and every walk did exactly that, photographed the panel, and
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
     * conversation they were reading. That round trip now has an extra hop - the
     * panel - and `returnTo` has to survive it, because the panel appends it to
     * the `/api/auth/login` it eventually calls.
     */
    const { location } = redirectFor('/en/inbox?c=abc');
    const target = new URL(location, 'https://dev.gotcha.co.il');
    expect(target.searchParams.get('returnTo')).toBe('/en/inbox?c=abc');
  });

  it('★★ the language in the URL wins; Accept-Language decides only without one', () => {
    /*
     * It used to choose no locale, for `Accept-Language` to decide. But a
     * language in the path is one the visitor picked: an en-US browser on
     * `/he/...` was signed in in English (dev, 2026-10-07).
     */
    const he = new URL(redirectFor('/he/inbox').location, 'https://dev.gotcha.co.il');
    expect(he.pathname).toBe('/he/sign-in');
    const en = new URL(redirectFor('/en/home').location, 'https://dev.gotcha.co.il');
    expect(en.pathname).toBe('/en/sign-in');
    const none = new URL(redirectFor('/home').location, 'https://dev.gotcha.co.il');
    expect(none.pathname).toBe('/sign-in');
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
     *   `gotcha_session_dev` - the LEGACY product's name, which ends in `_dev`
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
     * they were signed in - and when this destination changed today, browsers
     * went on replaying the old one for an hour after the server had moved.
     *
     * ★ The precise claim, because the loose one is wrong: a bare 307 is NOT
     *   heuristically cacheable - RFC 9111 §4.2.2 lists 200, 203, 204, 206,
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

describe('⚠⚠ the gate can send people to a sign-in screen on another origin', () => {
  /*
   * ═════════════════════════════════════════════════════════════════════════════
   * THREE DESTINATIONS, AND TWO OF THEM MEAN OPPOSITE THINGS
   * ═══════════════════════════════════════════════════════════════════════════
   * `PLATFORM_LOGIN_URL` means "do not use our panel at all". `SIGN_IN_URL`
   * means "our panel, on another host". Borrowing one variable for both would
   * make a deployment that wanted the second silently get the first, and the
   * symptom would be somebody landing on the legacy product’s login - which
   * looks like a working sign-in.
   */
  const gate = async (
    env: Record<string, string>,
    path = '/en/home',
    /** How the request ARRIVED, which is not always how the visitor sees it. */
    arrival: { host?: string; forwardedHost?: string } = {},
  ) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { gate: freshProxy } = await import('./proxy');
    const response = freshProxy(
      new NextRequest(`https://${arrival.host ?? 'dev.gotcha.co.il'}${path}`, {
        headers: arrival.forwardedHost ? { 'x-forwarded-host': arrival.forwardedHost } : undefined,
      }),
    );
    const result = { status: response.status, location: response.headers.get('location') ?? '' };
    vi.unstubAllEnvs();
    vi.resetModules();
    return result;
  };

  const AUTH_SIGN_IN = 'https://auth-dev.gotcha.co.il/sign-in';

  it('⚠⚠ sends them to the configured screen, on its own origin', async () => {
    const { status, location } = await gate({ SIGN_IN_URL: AUTH_SIGN_IN });
    expect(status).toBe(307);
    expect(new URL(location).origin).toBe('https://auth-dev.gotcha.co.il');
    expect(new URL(location).pathname).toBe('/en/sign-in');
  });

  it('★★ in the language the URL picked, both ways across the origin', async () => {
    // From the product: the path's language to the sign-in origin.
    const from = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, '/he/inbox');
    expect(new URL(from.location).pathname).toBe('/he/sign-in');
    // The old sign-in path on this origin: the same screen, in its language.
    const moved = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, '/he/sign-in');
    expect(new URL(moved.location).pathname).toBe('/he/sign-in');
    const recover = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, '/he/recover?flow=abc');
    expect(new URL(recover.location).pathname).toBe('/he/recover');
    expect(new URL(recover.location).searchParams.get('flow')).toBe('abc');
    // No language in the path: left to Accept-Language there.
    const bare = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, '/sign-in');
    expect(new URL(bare.location).pathname).toBe('/sign-in');
  });

  it('⚠⚠ carries `returnTo` across the origin, or every deep link is lost', async () => {
    /*
     * The round trip the design requires now crosses TWO origin boundaries -
     * here, and again when the panel hands over. Each hop has to keep it, and
     * a test of only the same-host form passed while this one dropped it.
     */
    const { location } = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, '/en/inbox?c=abc');
    expect(new URL(location).searchParams.get('returnTo')).toBe('/en/inbox?c=abc');
  });

  it('★★ `PLATFORM_LOGIN_URL` still wins over it', async () => {
    /*
     * Precedence, stated as a test because it is the kind of thing a later
     * refactor reorders without noticing. Handing off to the platform’s own
     * login is a deliberate deployment choice and neither our panel nor a
     * relocated copy of it may preempt that.
     */
    const { location } = await gate({
      SIGN_IN_URL: AUTH_SIGN_IN,
      PLATFORM_LOGIN_URL: 'https://dev.gotcha.co.il/api/auth/login',
    });
    expect(new URL(location).host).toBe('dev.gotcha.co.il');
    expect(new URL(location).pathname).toBe('/api/auth/login');
  });

  it('⚠⚠ and this origin STOPS SERVING the sign-in screen once it has moved', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════════
     * POINTING THE GATE ELSEWHERE RELOCATES THE PANEL. IT DOES NOT REMOVE THIS
     * ONE.
     * ═══════════════════════════════════════════════════════════════════════════
     * `/en/sign-in` would go on rendering a password field - working perfectly,
     * reachable by bookmark, by an old link, or by the callback’s own
     * `?error=expired` redirect - on the origin whose CSP is measured to allow
     * `unsafe-inline`, `unsafe-eval` and a third-party script host.
     *
     * Moving the panel to a clean origin and leaving a working copy on the
     * dirty one collects none of the benefit and keeps every cost. It is the
     * orphaned route inverted: not a screen nothing points at, but a screen
     * that still answers after everything stopped pointing at it.
     */
    for (const path of ['/sign-in', '/en/sign-in', '/he/sign-in']) {
      const { status, location } = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, path);
      expect(status, path).toBe(307);
      expect(new URL(location).host, path).toBe('auth-dev.gotcha.co.il');
    }
  });

  it('⚠⚠ carrying the whole query, not the parameters somebody listed', async () => {
    /*
     * `error` arrives here too - the OIDC callback redirects to THIS path with
     * `?error=expired`. A named list of the parameters we thought of is the
     * shape that drops the next one silently, and the symptom would be a
     * person sent back to a sign-in screen that has forgotten why.
     */
    const { location } = await gate(
      { SIGN_IN_URL: AUTH_SIGN_IN },
      '/en/sign-in?error=expired&returnTo=%2Fen%2Finbox',
    );
    const target = new URL(location);
    expect(target.searchParams.get('error')).toBe('expired');
    expect(target.searchParams.get('returnTo')).toBe('/en/inbox');
  });

  it('⚠⚠ a same-origin target is ignored rather than looping on the front door', async () => {
    /*
     * `SIGN_IN_URL` naming this host would send `/sign-in` to itself, or to a
     * form `intlMiddleware` bounces straight back - an inescapable redirect
     * chain on the first page anybody sees. The variable exists for another
     * origin, so a value that is not one is a misconfiguration, and the safe
     * reading is today’s behaviour.
     */
    const { status } = await gate(
      { SIGN_IN_URL: 'https://dev.gotcha.co.il/v2/sign-in' },
      '/en/sign-in',
    );
    expect(status).not.toBe(307);
  });

  it('★★ and the AUTH build never relocates its own screen', async () => {
    /*
     * The other loop. If both variables were ever present on the auth build it
     * would redirect sign-in away from the only host that serves it. Excluded
     * by construction - `PRODUCT_LOGIN_URL` means "I am the sign-in origin" -
     * and asserted, because "by construction" is a claim.
     */
    const { status } = await gate(
      {
        SIGN_IN_URL: AUTH_SIGN_IN,
        PRODUCT_LOGIN_URL: 'https://dev.gotcha.co.il/v2/api/auth/login',
      },
      '/en/sign-in',
    );
    expect(status).not.toBe(307);
  });

  it('⚠⚠ the loop guard also reads `x-forwarded-host`, which is the real deployment', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════════
     * `nextUrl.host` IS THE CONNECTION'S HOST, NOT THE VISITOR'S
     * ═══════════════════════════════════════════════════════════════════════════
     * Measured against the built image: a probe reaching the container
     * directly saw `nextUrl.host` = `127.0.0.1:3999` and Next **ignored
     * `x-forwarded-host` entirely**. Behind the gateway it is usually the
     * public host because nginx passes `Host` through, and "usually" is not
     * something to rest a loop guard on.
     *
     * This is the case a container probe cannot construct - it cannot stand
     * where the code stands - and it is trivial here, which is the division of
     * labour rather than a gap.
     */
    const { status } = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, '/en/sign-in', {
      host: 'frontend-v2:3000',
      forwardedHost: 'auth-dev.gotcha.co.il',
    });
    expect(status).not.toBe(307);
  });

  it('★★ and a forwarded host that is NOT the target still relocates', async () => {
    /*
     * Both directions, and this is the one that matters in production: the
     * visitor arrives on the product host, the target is the auth host, and
     * the redirect must happen. A guard that fired on any forwarded header at
     * all would satisfy the test above and break every real request.
     */
    const { status, location } = await gate({ SIGN_IN_URL: AUTH_SIGN_IN }, '/en/sign-in', {
      host: 'frontend-v2:3000',
      forwardedHost: 'dev.gotcha.co.il',
    });
    expect(status).toBe(307);
    expect(new URL(location).host).toBe('auth-dev.gotcha.co.il');
  });

  it('★★ and unset is today’s behaviour, unchanged', async () => {
    // Both directions. A gate that always used a configured URL would be
    // broken on every deployment that has none - which is all of them today.
    const { status, location } = await gate({});
    expect(status).toBe(307);
    expect(new URL(location, 'https://dev.gotcha.co.il').pathname).toBe('/en/sign-in');
    expect(location).not.toContain('auth-dev');
  });
});

describe('⚠⚠ on the auth origin, this build serves sign-in and nothing else', () => {
  /*
   * ═════════════════════════════════════════════════════════════════════════════
   * A SECOND REFUSAL, BECAUSE THE FIRST ONE IS ONE NGINX RULE
   * ═══════════════════════════════════════════════════════════════════════════
   * A root-mounted build compiles every route, so the gateway allowlist is a
   * security control - and its first version permitted `/sign-in` while the
   * app answered 307 to `/en/sign-in`, so the screen 404’d behind a redirect
   * that looked fine. These assert the app refuses too.
   *
   * ★ Derived from `PRODUCT_LOGIN_URL`, not a flag. That variable already
   *   means "I am the sign-in origin", so there is no second value to get
   *   wrong and no way to 404 the product except by telling the product where
   *   the product is.
   */
  const stubbed = async (env: Record<string, string>, path: string, cookie?: string) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { gate: freshProxy } = await import('./proxy');
    const response = freshProxy(
      new NextRequest(`https://auth-dev.gotcha.co.il${path}`, {
        headers: cookie ? { cookie } : undefined,
      }),
    );
    const result = { status: response.status, location: response.headers.get('location') };
    vi.unstubAllEnvs();
    vi.resetModules();
    return result;
  };

  const AUTH_BUILD = { PRODUCT_LOGIN_URL: 'https://dev.gotcha.co.il/v2/api/auth/login' };

  it('⚠⚠ refuses every product route, including ones nobody listed', async () => {
    /*
     * The last two matter most. An allowlist that covers the routes we thought
     * of and leaks the one we did not passes every test built from the list -
     * and the list is the thing most likely to be incomplete.
     */
    for (const path of [
      '/en/home',
      '/en/inbox',
      '/he/inbox',
      '/en/approvals',
      '/en/settings/billing',
      '/studio',
      '/',
    ]) {
      const { status } = await stubbed(AUTH_BUILD, path);
      expect(status, path).toBe(404);
    }
  });

  it('⚠⚠ refuses rather than redirecting, so nothing leaks across origins', async () => {
    /*
     * A 307 to the product would also "not serve" the route, and would mean
     * the isolation is one `Location` header from gone - and it would tell an
     * unauthenticated visitor that the route exists and where.
     */
    const { location } = await stubbed(AUTH_BUILD, '/en/inbox');
    expect(location).toBeNull();
  });

  it('★★ and still serves the sign-in screen, at every spelling of it', async () => {
    // Both directions. A build that refused everything satisfies all of the
    // above and is a blank auth origin.
    for (const path of ['/sign-in', '/en/sign-in', '/he/sign-in', '/en/sign-in/']) {
      const { status } = await stubbed(AUTH_BUILD, path);
      expect(status, path).not.toBe(404);
    }
  });

  it('⚠⚠ refuses a path that merely starts with the same letters', async () => {
    // `/en/sign-inbox` is not the sign-in page. This is the boundary the
    // pattern’s `(?:\/|$)` exists for, and the one a prefix allowlist misses.
    const { status } = await stubbed(AUTH_BUILD, '/en/sign-inbox');
    expect(status).toBe(404);
  });

  it('★★ and the PRODUCT build is untouched, or this is a total outage', async () => {
    /*
     * The failure mode that made a boolean flag the wrong shape: a value on the
     * wrong image 404s the whole product. Deriving it makes that unconstructible
     * - but unconstructible is a claim, and this is the assertion.
     */
    expect((await stubbed({}, '/en/home', 'gotcha_session=abc')).status).not.toBe(404);
    expect((await stubbed({}, '/en/inbox', 'gotcha_session=abc')).status).not.toBe(404);
    // Signed out, the product still redirects to sign-in rather than refusing.
    const signedOut = await stubbed({}, '/en/home');
    expect(signedOut.status).toBe(307);
    expect(signedOut.location).toContain('/sign-in');
  });
});

describe('⚠⚠ the variable that triggers the refusal can never be baked into an image', () => {
  /*
   * ═════════════════════════════════════════════════════════════════════════════
   * THE ONE FAILURE MODE THIS DESIGN TRADES AWAY, ASSERTED RATHER THAN CLAIMED
   * ═══════════════════════════════════════════════════════════════════════════
   * `PRODUCT_LOGIN_URL` on the product’s own deployment 404s every route in the
   * product. Deriving the refusal from it rather than from a flag makes that
   * combination nonsense - you would be telling the product where the product
   * is - but nonsense is not the same as impossible.
   *
   * ★ An `ENV` line in the Dockerfile would put it in EVERY container from that
   *   image, which is the one way it could arrive without anybody choosing it
   *   per-deployment. That is the half of the claim this repository can see.
   *
   * ⚠ THE OTHER HALF IS NOT HERE AND IS NOT COVERED. Whether the running
   *   `/v2` service has this variable is a fact about a compose file in another
   *   repository, and no test in this one can reach it. Said plainly rather
   *   than left as an implied guarantee.
   */
  it('⚠⚠ the Dockerfile neither defaults nor exports it', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).not.toMatch(/^\s*ENV\s+PRODUCT_LOGIN_URL/m);
    expect(dockerfile).not.toMatch(/^\s*ARG\s+PRODUCT_LOGIN_URL\s*=/m);
  });

  it('★ and the example file ships it commented out', () => {
    /*
     * `.env.example` is copied by people starting from it. An uncommented line
     * there is how a local run - or a deployment assembled from it - acquires
     * the variable without anybody deciding to.
     */
    const example = readFileSync('.env.example', 'utf8');
    expect(example).toContain('PRODUCT_LOGIN_URL');
    expect(example).not.toMatch(/^\s*PRODUCT_LOGIN_URL\s*=/m);
  });
});

describe('★★ the narrower policy reaches the page that has a password on it', () => {
  it('★★ sign-in gets no `https:` image wildcard', () => {
    expect(directive(cspFor('/en/sign-in'), 'img-src')).toEqual(["'self'", 'data:']);
  });

  it('★★ and every other page keeps it, or avatars break', () => {
    /*
     * Both directions. A narrowing that leaked into the product would stop
     * customer photos loading and read as a backend failure - and a test that
     * only checked sign-in could not tell the two apart.
     */
    expect(directive(cspFor('/en/home'), 'img-src')).toContain('https:');
    expect(directive(cspFor('/en/inbox'), 'img-src')).toContain('https:');
  });

  it('★★ matches sign-in with and without a locale, and with a trailing slash', () => {
    /*
     * The pattern decides both the auth gate and now the policy. A locale it does
     * not match would be a sign-in page that is ALSO treated as private - an
     * infinite redirect - so this list is not cosmetic.
     */
    for (const path of ['/sign-in', '/en/sign-in', '/he/sign-in', '/en/sign-in/']) {
      expect(directive(cspFor(path), 'img-src'), path).toEqual(["'self'", 'data:']);
    }
  });

  it('★★ does not match a path that merely starts with the same letters', () => {
    /*
     * `/sign-in-help` is not the sign-in page. A prefix match here would hand a
     * narrower policy to an unrelated route - and, through the same pattern,
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

describe('★★ 13c - which paths get Meta’s frames', () => {
  it.each([
    ['/en/settings/channels', true],
    ['/he/settings/channels/whatsapp', true],
    ['/en/settings/channelsx', false],
    ['/en/sign-in', false],
    ['/en/settings/workspace', false],
  ])('%s → %s', async (path, framed) => {
    const { META_SIGNUP_PATH } = await import('./proxy');
    expect(META_SIGNUP_PATH.test(path)).toBe(framed);
  });

  it('the response for a channels page carries them; sign-in does not', async () => {
    const csp = async (path: string) =>
      (await proxy(new NextRequest(`https://dev.gotcha.co.il${path}`))).headers.get(
        'content-security-policy',
      ) ?? '';
    expect(await csp('/en/settings/channels')).toContain('https://www.facebook.com');
    expect(await csp('/en/sign-in')).not.toContain('facebook.com');
  });
});
