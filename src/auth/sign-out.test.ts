import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two ways this app sends a browser out of itself.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ NEITHER HAD A TEST, AND ONE OF THEM WENT TO THE WRONG APPLICATION
 * ════════════════════════════════════════════════════════════════════════════
 * `startSignIn` used a bare `/api/auth/login`. `window.location.assign` is a
 * plain web API — an absolute path resolves against the ORIGIN, not the mount
 * point — so under `/v2` a session expiring mid-work sent the person to the
 * LEGACY product's login, with our `returnTo` on the query.
 *
 * ★ It is the third spelling of one defect: an `href` (the sign-in button), a
 *   `new URL` against an origin carrying a path (the OIDC `redirect_uri`), and
 *   now a `location.assign`. A sweep for any one shape finds that one.
 */

const assign = vi.fn();

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('location', { assign, pathname: '/en/home', search: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const underBasePath = async (basePath: string) => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', basePath);
  return import('./sign-out');
};

describe('⚠⚠ starting sign-in after a session expires', () => {
  it('⚠⚠ stays inside this application when it is mounted under a prefix', async () => {
    const { startSignIn } = await underBasePath('/v2');
    startSignIn('/en/inbox?c=abc');

    const target = assign.mock.calls[0]![0] as string;
    expect(target.startsWith('/v2/api/auth/login')).toBe(true);
    // The whole point: unprefixed, this is another product's route.
    expect(target.startsWith('/api/auth/login')).toBe(false);
  });

  it('★★ carries `returnTo`, encoded, or the expiry loses their place', async () => {
    /*
     * Somebody whose session expires mid-conversation should come back to that
     * conversation. The value is a path WITH a query of its own, so it has to
     * be encoded — unencoded, its `?` starts a second parameter and the rest is
     * silently dropped.
     */
    const { startSignIn } = await underBasePath('/v2');
    startSignIn('/en/inbox?c=abc');

    const target = new URL(assign.mock.calls[0]![0] as string, 'https://dev.gotcha.co.il');
    expect(target.searchParams.get('returnTo')).toBe('/en/inbox?c=abc');
  });

  it('★ and is a plain path at the root, where the prefix is empty', async () => {
    // Both directions. Asserting the ABSENCE of a prefix proves nothing at a
    // base path that is empty by default — so the case above uses `/v2`, and
    // this one records what the root actually produces.
    const { startSignIn } = await underBasePath('');
    startSignIn('/en/home');
    expect(assign.mock.calls[0]![0]).toBe('/api/auth/login?returnTo=%2Fen%2Fhome');
  });
});

describe('★ signing out', () => {
  it('★★ posts to this application, not to the origin root', async () => {
    /*
     * `fetch` is not prefixed either. This one was already correct — and being
     * correct in the same file is exactly what let the defect above hide: a
     * sweep that checked whether `sign-out.ts` calls `appPath` found that it
     * does.
     */
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ redirectTo: 'https://idp.example/end-session' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { signOut } = await underBasePath('/v2');
    await signOut();

    expect(fetchMock.mock.calls[0]![0]).toBe('/v2/api/auth/logout');
    expect(assign).toHaveBeenCalledWith('https://idp.example/end-session');
  });
});
