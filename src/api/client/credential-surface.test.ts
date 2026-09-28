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
