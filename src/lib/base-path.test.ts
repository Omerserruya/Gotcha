import { describe, expect, it } from 'vitest';

import { appPath, appUrl, BASE_PATH } from './base-path';

/**
 * Where this app is mounted, and the two web APIs that do not know.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `new URL('/a', 'https://host/v2')` IS `https://host/a`
 * ════════════════════════════════════════════════════════════════════════════
 * An absolute path **discards the base's path**, with or without a trailing
 * slash. That is standard and it is the whole reason this module exists: the
 * OIDC `redirect_uri` was composed as
 * `new URL('/api/auth/callback', APP_ORIGIN)`, so an `APP_ORIGIN` ending in
 * `/v2` produced a callback URL at the root — which, beside the legacy
 * product, is another application's route rather than a 404.
 *
 * These tests run at the root (`BASE_PATH === ''`), so they pin the behaviour
 * that survives either way: the shape of the composition, not the prefix.
 */

describe('★★ the URL trap this module exists for', () => {
  it('★★ an absolute path discards the base path — the standard behaviour', () => {
    // Not our code: the platform's `URL`. Pinned because a reader who does not
    // know this will "simplify" `appUrl` back into `new URL(path, origin)`.
    expect(new URL('/api/auth/callback', 'https://host/v2').toString()).toBe(
      'https://host/api/auth/callback',
    );
    // A trailing slash does not save it.
    expect(new URL('/sign-in', 'https://host/v2/').toString()).toBe('https://host/sign-in');
    // Only a RELATIVE reference keeps the base's path, and then only with the
    // trailing slash — which is too subtle to build authentication on.
    expect(new URL('sign-in', 'https://host/v2/').toString()).toBe('https://host/v2/sign-in');
  });

  it('★★ appUrl rebuilds the path instead of resolving against it', () => {
    /*
     * The result must not depend on whether whoever set `APP_ORIGIN` included
     * the prefix — an environment variable and a build flag disagreeing is
     * exactly the failure this avoids.
     */
    const withPrefix = appUrl('/api/auth/callback', 'https://host/v2');
    const without = appUrl('/api/auth/callback', 'https://host');
    expect(withPrefix).toBe(without);
    expect(withPrefix).toBe(`https://host${BASE_PATH}/api/auth/callback`);
  });

  it('★ keeps the origin, including a port', () => {
    expect(appUrl('/sign-in', 'http://localhost:3000')).toBe(
      `http://localhost:3000${BASE_PATH}/sign-in`,
    );
  });
});

describe('★ appPath', () => {
  it('prefixes an in-app path', () => {
    expect(appPath('/api/bff')).toBe(`${BASE_PATH}/api/bff`);
  });

  it('★ is a no-op at the root, which is how local development stays unchanged', () => {
    /*
     * `NEXT_PUBLIC_BASE_PATH` is unset in development and in the capture runs,
     * so every spec still navigates to `/${locale}/…`. A hardcoded prefix
     * would have moved all 22 of them.
     */
    expect(BASE_PATH).toBe('');
    expect(appPath('/api/bff')).toBe('/api/bff');
  });
});
