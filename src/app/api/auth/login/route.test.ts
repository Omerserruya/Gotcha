import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The second door to the identity provider's own login page.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THIS ROUTE HAD NOTHING IN FRONT OF IT
 * ════════════════════════════════════════════════════════════════════════════
 * It IS the OIDC start, so it goes straight to `authorize` — and with no
 * identity-provider session the provider renders **its own login page**, the
 * screen the whole origin separation exists to stop anyone seeing. The
 * middleware cannot help: its matcher excludes `/api`.
 *
 * Reached twice from a bookmark carrying `?next=/application/o/authorize/`,
 * and not only from bookmarks — `SessionExpiryWatcher` came here too.
 *
 * ★ The gate and this route gave two different answers to one question:
 *   `proxy.ts` sends an unauthenticated visitor to `SIGN_IN_URL`, this sent
 *   them to the provider. "One way in" is the design.
 */

const { serverEnv } = vi.hoisted(() => ({
  serverEnv: vi.fn(() => ({
    OIDC_SCOPES: 'openid',
    APP_ORIGIN: 'https://dev.gotcha.co.il/v2',
  })),
}));
vi.mock('@/config/env.server', () => ({ serverEnv }));

/*
 * The OIDC client is mocked so the marker path can be exercised at all. It is
 * NOT the subject here — what is asserted is which of the two destinations this
 * route chooses, and a test that could only reach one of them would be half a
 * test.
 */
vi.mock('@/auth/oidc', () => ({
  oidcConfiguration: async () => ({}),
  buildAuthorizationUrl: () => new URL('https://auth-dev.gotcha.co.il/application/o/authorize/'),
  calculatePKCECodeChallenge: async () => 'challenge',
  randomPKCECodeVerifier: () => 'verifier',
  randomState: () => 'state',
  redirectUri: () => 'https://dev.gotcha.co.il/v2/api/auth/callback',
}));

/*
 * ★ A top-level `import type`, not `typeof import(…)` inline:
 *   `@typescript-eslint/consistent-type-imports` forbids the annotation form,
 *   and this is the second time I have written it in a `vi.mock` factory.
 */
/*
 * ★ No type argument and no `typeof import(…)`:
 *   `@typescript-eslint/consistent-type-imports` forbids the annotation form,
 *   and this is the second time I have written it inside a `vi.mock` factory.
 *   `safeReturnPath` has to be the REAL one — one of the assertions below is
 *   that a hostile `returnTo` is still refused on this path.
 */
vi.mock('@/auth/login-state', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, sealLoginState: async () => 'sealed' };
});

const { GET, HANDOVER_PARAM } = await import('./route');

const get = async (query = '') =>
  GET(new NextRequest(`https://dev.gotcha.co.il/v2/api/auth/login${query}`));

const AUTH = 'https://auth-dev.gotcha.co.il/sign-in';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('⚠⚠ arriving at the OIDC start without going through the panel', () => {
  it('⚠⚠ is sent to the sign-in screen, not to the identity provider', async () => {
    vi.stubEnv('SIGN_IN_URL', AUTH);
    const response = await get();
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').host).toBe('auth-dev.gotcha.co.il');
  });

  it('⚠⚠ keeps `returnTo`, or a bookmark costs somebody their place', async () => {
    vi.stubEnv('SIGN_IN_URL', AUTH);
    const response = await get('?returnTo=%2Fen%2Finbox%3Fc%3Dabc');
    const target = new URL(response.headers.get('location') ?? '');
    expect(target.searchParams.get('returnTo')).toBe('/en/inbox?c=abc');
  });

  it('★ and a hostile `returnTo` is still refused on the way', async () => {
    /*
     * This branch reads the query and builds a URL from it, so it is a second
     * place the open-redirect guard has to hold. `safeReturnPath` runs first;
     * asserting it here means a future refactor cannot quietly move the
     * redirect above the validation.
     */
    vi.stubEnv('SIGN_IN_URL', AUTH);
    const response = await get('?returnTo=%2F%09%2Fevil.example');
    const target = new URL(response.headers.get('location') ?? '');
    expect(target.searchParams.get('returnTo')).toBe('/');
  });

  it('★★ but OUR PANEL handing over still starts OIDC, or nobody can sign in', async () => {
    /*
     * Both directions, and this is the one that matters: by the time the panel
     * navigates here it has already created the provider session, so
     * `authorize` returns silently. Sending it back to the panel would be an
     * infinite loop on the front door.
     */
    vi.stubEnv('SIGN_IN_URL', AUTH);
    const response = await get(`?${HANDOVER_PARAM}=1`);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/application/o/authorize/');
  });

  it('★★ and with no sign-in origin configured, nothing changes', async () => {
    /*
     * The whole product today. This route is the OIDC start and must stay so
     * when sign-in is served from the same host.
     */
    const response = await get();
    expect(response.headers.get('location')).toContain('/application/o/authorize/');
  });

  it('★ the redirect to the panel is not storable', async () => {
    // Its destination depends on deployment configuration and on a session.
    vi.stubEnv('SIGN_IN_URL', AUTH);
    expect((await get()).headers.get('cache-control')).toBe('no-store');
  });
});
