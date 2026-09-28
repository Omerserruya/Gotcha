import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refuseOnCredentialSurface } from './credential-surface';

/**
 * The route handlers the middleware's refusal cannot see.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ `proxy.ts`'s MATCHER EXCLUDES `/api`
 * ════════════════════════════════════════════════════════════════════════════
 * Every page route on the sign-in origin is refused twice — by the gateway
 * allowlist and by the app. `/api/bff/…`, which forwards the caller's platform
 * session upstream, had the allowlist and nothing else, because middleware
 * never runs for a route handler.
 *
 * ★ The guard read as covering the app. It covered the part of the app its
 *   matcher could see — the same defect as a sweep organised by file: correct
 *   about everything it examines, silent about what it does not.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('⚠⚠ refusing on the sign-in origin', () => {
  const request = () => new NextRequest('https://auth-dev.gotcha.co.il/api/bff/api/conversations');

  it('⚠⚠ refuses when this build is the sign-in origin', () => {
    vi.stubEnv('PRODUCT_LOGIN_URL', 'https://dev.gotcha.co.il/v2/api/auth/login');
    const refusal = refuseOnCredentialSurface(request());
    expect(refusal?.status).toBe(404);
  });

  it('★★ and does nothing on the product, or every API call 404s', () => {
    /*
     * Both directions. The whole failure mode this design trades away is a
     * value on the wrong image — and here it would take out every API call in
     * the product rather than only its pages.
     */
    expect(refuseOnCredentialSurface(request())).toBeNull();
  });

  it('★ the refusal is not storable', () => {
    /*
     * It is an answer about which deployment is running. A browser holding it
     * across a configuration change would be answering for the wrong one.
     */
    vi.stubEnv('PRODUCT_LOGIN_URL', 'https://dev.gotcha.co.il/v2/api/auth/login');
    expect(refuseOnCredentialSurface(request())?.headers.get('cache-control')).toBe('no-store');
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ THE PROPERTY IS "EVERY HANDLER", WHICH NO UNIT TEST CAN SEE
   * ══════════════════════════════════════════════════════════════════════════
   * A test that drove one route would pass while a sixth was added without the
   * guard, and that is exactly how this rots — not a guard written wrongly, a
   * route added later. So the set is read from the DIRECTORY rather than from
   * a list somebody maintains, which is the same reason `messages.test.ts`
   * enumerates its folder.
   */
  it('⚠⚠ the middleware matcher skips a dotted path, and that is asserted not assumed', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════════
     * THE SECOND HOLE IN THE SAME MATCHER, AND IT IS NOT `/api`
     * ═══════════════════════════════════════════════════════════════════════════
     * `.*\..*` excludes any path with a dot in it. Two dynamic routes take an
     * id, so `/en/customers/a.b@c.com` reaches the app with **no** refusal,
     * no auth gate and no narrowed CSP in front of it.
     *
     * ★ It is latent, and only because this app’s session cookie sets no
     *   `domain` and so never reaches the sign-in origin. That is asserted
     *   here too — the gap and the thing that closes it, in one place, because
     *   a future `domain` would make this live and nothing else would say so.
     *
     * The regex is read from `proxy.ts` rather than copied, or this test
     * asserts a matcher that was true when somebody wrote it down.
     */
    const source = readFileSync('src/proxy.ts', 'utf8');
    const declared = /matcher: \[(.*?)\]/s.exec(source)?.[1] ?? '';
    const pattern = /'\/\(\((.*?)\)\.\*\)'/.exec(declared)?.[1];
    expect(pattern, 'the matcher is not in the shape this test reads').toBeTruthy();

    /*
     * ★ The source is a STRING literal, so `\\.` there is `\.` in the regex it
     *   builds. Reading it back without undoing that escape produced a pattern
     *   matching a literal backslash — and the first run of this test claimed
     *   the dotted path was covered. The extraction was wrong in the
     *   reassuring direction, which is the only direction that matters.
     */
    const matches = new RegExp(`^/((${pattern!.replaceAll('\\\\', '\\')}).*)$`);
    expect(matches.test('/en/home')).toBe(true);
    // ★ The gap, pinned. If somebody narrows the exclusion this reddens, which
    //   is the point: it should be re-read, not silently satisfied.
    expect(matches.test('/en/customers/a.b@c.com')).toBe(false);
    expect(matches.test('/api/bff/api/conversations')).toBe(false);

    /*
     * And what keeps it latent — read from the source rather than by calling
     * it, because `sessionCookieOptions` validates the whole server
     * environment first and constructing eleven variables to learn one fact
     * would make this test about the environment instead.
     */
    const session = readFileSync('src/auth/session.ts', 'utf8');
    /*
     * ⚠ THE FIRST VERSION OF THIS READ THE SIGNATURE, NOT THE BODY.
     * `sessionCookieOptions` declares its return type as an object literal, so
     * `[\s\S]*?\n}` stopped at the `}` closing the ANNOTATION. Adding
     * `domain:` to the returned object left the assertion green — a mutation
     * caught it, nothing else would have. Anchored on `return {` now.
     */
    const body = session.slice(session.indexOf('export function sessionCookieOptions'));
    const start = body.indexOf('return {');
    // ⚠ Measured from `start`, not from the function: the RETURN TYPE is also
    //   an object literal, so the first `\n}` in the function closes the
    //   annotation and a slice ending there is empty. Second reading of this
    //   one file that stopped at the signature.
    const returned = body.slice(start, start + body.slice(start).indexOf('\n}'));
    expect(returned, 'sessionCookieOptions is not where this test looks').toContain('sameSite');
    expect(returned).not.toMatch(/^\s*domain:/m);
  });

  it('⚠⚠ every route handler in the app calls it', () => {
    const handlers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === 'route.ts') handlers.push(path);
      }
    };
    walk('src/app/api');

    expect(handlers.length, 'no route handlers found — the scan is broken').toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(readFileSync(handler, 'utf8'), handler).toContain(
        'refuseOnCredentialSurface(request)',
      );
    }
  });
});
