// @vitest-environment node
// jose seals with Node's Uint8Array; jsdom's TextEncoder hands it another realm's.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_STATE_COOKIE } from '@/auth/login-state';

/**
 * The endpoint that mints the session - and it had no tests at all.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE MOST SECURITY-CRITICAL ROUTE IN THE APP WAS THE LEAST COVERED
 * ════════════════════════════════════════════════════════════════════════════
 * Everything else in the sign-in path has tests - the panel, the contract, the
 * proxy, the login route. This is the one that turns a code into a session,
 * and there was no `route.test.ts` beside it. Found by needing to assert a
 * two-branch conditional and discovering there was nowhere to put it.
 *
 * ★ These do not re-test `openid-client`. They assert what THIS file hands it
 *   and what it does with each answer, which is the part we wrote.
 */
/*
 * The real `serverEnv` validates a full production environment and throws
 * here. This file is about what the callback DOES with a code, so the
 * environment is supplied rather than assembled.
 */
const { serverEnv } = vi.hoisted(() => ({
  serverEnv: vi.fn(() => ({
    APP_ORIGIN: 'https://dev.gotcha.co.il/v2',
    SESSION_MAX_AGE_SECONDS: 28800,
    SESSION_SECRET: 'x'.repeat(32),
  })),
}));
vi.mock('@/config/env.server', () => ({ serverEnv }));

const authorizationCodeGrant = vi.hoisted(() => vi.fn());
const unsealLoginState = vi.hoisted(() => vi.fn());
const sealSession = vi.hoisted(() => vi.fn(async () => 'sealed-session'));

vi.mock('@/auth/oidc', () => ({
  authorizationCodeGrant,
  oidcConfiguration: async () => ({}),
}));

vi.mock('@/auth/login-state', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, unsealLoginState };
});

vi.mock('@/auth/session', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, sealSession };
});

const recordSignIn = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/sign-in-record', () => ({ recordSignIn }));

const { GET } = await import('./route');
const { sealConnectIntent, CONNECT_COOKIE, TERMS_PENDING_COOKIE } =
  await import('@/auth/google-sign-in');

const CODE_URL = 'https://dev.gotcha.co.il/v2/api/auth/callback?code=the-code&state=the-state';

const get = async (url = CODE_URL) => {
  const request = new NextRequest(url);
  request.cookies.set(LOGIN_STATE_COOKIE, 'sealed');
  return GET(request);
};

const tokens = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_in: 300,
  claims: () => ({ sub: 'user-1' }),
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizationCodeGrant.mockResolvedValue(tokens);
  sealSession.mockResolvedValue('sealed-session');
  unsealLoginState.mockResolvedValue({ v: 'verifier', s: 'the-state', r: '/inbox', n: 'nonce' });
  recordSignIn.mockResolvedValue({ method: 'password', google: null, termsRequired: false });
});

describe('⚠⚠ the nonce is expected only when one was sent', () => {
  it('★★ checks it when the sealed state carries one', async () => {
    await get();
    expect(authorizationCodeGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(URL),
      expect.objectContaining({
        pkceCodeVerifier: 'verifier',
        expectedState: 'the-state',
        expectedNonce: 'nonce',
      }),
    );
  });

  it('⚠⚠ and omits the KEY ENTIRELY for a cookie from a build that sent none', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * `expectedNonce: undefined` IS NOT THE SAME AS NOT PASSING IT
     * ════════════════════════════════════════════════════════════════════════
     * `openid-client` documents the parameter as: "When `undefined` the
     * expectation is that there is no `nonce` in the ID Token." That makes it
     * symmetric - and it means a sign-in started before this deploy, whose
     * token carries no nonce, must reach the exchange with the key ABSENT and
     * not merely undefined-valued.
     *
     * ★ Those sign-ins are in flight across a restart. Failing them would sign
     *   people out for the length of a deploy.
     */
    unsealLoginState.mockResolvedValue({ v: 'verifier', s: 'the-state', r: '/inbox' });

    await get();
    const options = authorizationCodeGrant.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect('expectedNonce' in options).toBe(false);
    expect(options.pkceCodeVerifier).toBe('verifier');
  });
});

describe('⚠⚠ every refusal fails closed, with no session', () => {
  const setsNoSession = (response: { cookies: { get: (n: string) => unknown } }) =>
    expect(response.cookies.get('gotcha_session')).toBeUndefined();

  it('★★ a failed exchange goes back to sign-in and mints nothing', async () => {
    authorizationCodeGrant.mockRejectedValue(new Error('nonce mismatch'));

    const response = await get();
    expect(response.headers.get('location')).toContain('error=exchange_failed');
    setsNoSession(response);
  });

  it('★★ an expired or replayed cookie is not an exchange at all', async () => {
    /*
     * `unsealLoginState` returning null means the cookie is gone, expired, or
     * was never ours. The provider must not be asked about the code: there is
     * nothing to verify it against.
     */
    unsealLoginState.mockResolvedValue(null);

    const response = await get();
    expect(response.headers.get('location')).toContain('error=expired');
    expect(authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('⚠ a provider error is reported as denial, not as a broken exchange', async () => {
    const response = await get('https://dev.gotcha.co.il/v2/api/auth/callback?error=access_denied');
    expect(response.headers.get('location')).toContain('error=denied');
    expect(authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('⚠⚠ a token with no `sub` is refused rather than made into a session', async () => {
    // A session keyed on `undefined` is one every such user would share.
    authorizationCodeGrant.mockResolvedValue({ ...tokens, claims: () => ({}) });

    const response = await get();
    expect(response.headers.get('location')).toContain('error=exchange_failed');
    setsNoSession(response);
  });
});

describe('★ what it hands openid-client is built here, not taken from the request', () => {
  it('⚠⚠ rebuilds the URL on APP_ORIGIN rather than trusting the Host header', async () => {
    /*
     * The `currentUrl` given to the exchange decides which redirect_uri the
     * library believes it is completing. Taking it from the incoming request
     * would let a stray Host header choose it.
     */
    await get();
    const currentUrl = authorizationCodeGrant.mock.calls.at(-1)?.[1] as URL;
    expect(currentUrl).toBeInstanceOf(URL);
    expect(currentUrl.origin).toBe('https://dev.gotcha.co.il');
    expect(currentUrl.searchParams.get('code')).toBe('the-code');
  });
});

describe('★★ Google sign-in: the record, the connect answer, the Terms (2026-11-22)', () => {
  const withConnect = async (subject: string | null, url = CODE_URL) => {
    const request = new NextRequest(url);
    request.cookies.set(LOGIN_STATE_COOKIE, 'sealed');
    if (subject) request.cookies.set(CONNECT_COOKIE, await sealConnectIntent(subject));
    return GET(request);
  };
  const deleted = (
    response: Response & { cookies: { get: (n: string) => unknown } },
    name: string,
  ) => {
    const cookie = response.cookies.get(name) as { value: string; expires?: Date } | undefined;
    return cookie !== undefined && cookie.value === '';
  };

  it('★★ posts the record with the NEW token, and no subject when nobody started a connect', async () => {
    await get();
    expect(recordSignIn).toHaveBeenCalledWith('at', null, expect.anything());
  });

  it('★★ hands over the sealed subject of a connect, read back from its cookie', async () => {
    await withConnect('user-1');
    expect(recordSignIn).toHaveBeenCalledWith('at', 'user-1', expect.anything());
  });

  it('⚠⚠ a tampered connect cookie is no subject at all', async () => {
    const request = new NextRequest(CODE_URL);
    request.cookies.set(LOGIN_STATE_COOKIE, 'sealed');
    request.cookies.set(CONNECT_COOKIE, 'not-a-sealed-value');
    await GET(request);
    expect(recordSignIn).toHaveBeenCalledWith('at', null, expect.anything());
  });

  it('★★ Backend’s marker lands on the connected-accounts card', async () => {
    recordSignIn.mockResolvedValue({ method: 'google', google: 'connected', termsRequired: false });
    const response = await withConnect('user-1');
    expect(response.headers.get('location')).toBe(
      'https://dev.gotcha.co.il/settings/security?google=connected',
    );
  });

  it('★ "other_account" lands there too, and says so', async () => {
    recordSignIn.mockResolvedValue({
      method: 'google',
      google: 'other_account',
      termsRequired: false,
    });
    const response = await withConnect('user-1');
    expect(response.headers.get('location')).toBe(
      'https://dev.gotcha.co.il/settings/security?google=other_account',
    );
  });

  it('★ a Google sign-in after a connect with a null answer lands on the card, saying nothing', async () => {
    recordSignIn.mockResolvedValue({ method: 'google', google: null, termsRequired: false });
    const response = await withConnect('user-1');
    expect(response.headers.get('location')).toBe('https://dev.gotcha.co.il/settings/security');
  });

  it('⚠⚠ a PASSWORD sign-in after an abandoned connect goes where it was going', async () => {
    const response = await withConnect('user-1');
    expect(response.headers.get('location')).toBe('https://dev.gotcha.co.il/inbox');
  });

  it('⚠⚠ the connect cookie is deleted on success and on failure alike', async () => {
    expect(deleted(await withConnect('user-1'), CONNECT_COOKIE)).toBe(true);
    authorizationCodeGrant.mockRejectedValue(new Error('nonce mismatch'));
    expect(deleted(await withConnect('user-1'), CONNECT_COOKIE)).toBe(true);
  });

  it('★★ owed Terms set the marker for the session’s own lifetime', async () => {
    recordSignIn.mockResolvedValue({ method: 'google', google: null, termsRequired: true });
    const response = await get();
    const marker = response.cookies.get(TERMS_PENDING_COOKIE);
    expect(marker?.value).toBe('1');
    expect(marker?.maxAge).toBe(28800);
    expect(marker?.httpOnly).toBe(true);
  });

  it('★ no Terms owed clears an old marker', async () => {
    expect(deleted(await get(), TERMS_PENDING_COOKIE)).toBe(true);
  });

  it('⚠⚠ a failed record is no marker of any kind, and the sign-in completes', async () => {
    recordSignIn.mockResolvedValue(null);
    const response = await withConnect('user-1');
    expect(response.headers.get('location')).toBe('https://dev.gotcha.co.il/inbox');
    expect(sealSession).toHaveBeenCalled();
    expect(deleted(response, TERMS_PENDING_COOKIE)).toBe(true);
  });
});

const { APP_HANDOFF_COOKIE, redeemHandoffCode, s256, sealHandoffStart } =
  await import('@/auth/app-handoff');

describe('★★ the app’s sign-in: the cookies go to the app, not to this browser (2026-11-24)', () => {
  const VERIFIER = 'v'.repeat(43);

  const getFromApp = async () => {
    const request = new NextRequest(CODE_URL);
    request.cookies.set(LOGIN_STATE_COOKIE, 'sealed');
    request.cookies.set(APP_HANDOFF_COOKIE, await sealHandoffStart(await s256(VERIFIER)));
    return GET(request);
  };

  it('★★ back on gotcha:// with a code that redeems to this session', async () => {
    recordSignIn.mockResolvedValue({ method: 'google', google: null, termsRequired: true });
    const response = await getFromApp();
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe('gotcha://auth/done');
    const redeemed = await redeemHandoffCode(location.searchParams.get('code') ?? '', VERIFIER);
    expect(redeemed).toEqual({ s: 'sealed-session', i: null, t: true });
  });

  it('⚠⚠ sets no session in this browser, and spends both one-trip cookies', async () => {
    const response = await getFromApp();
    const set = response.headers.getSetCookie();
    expect(set.some((line) => line.includes('sealed-session'))).toBe(false);
    expect(response.cookies.get(APP_HANDOFF_COOKIE)?.value).toBe('');
    expect(response.cookies.get(LOGIN_STATE_COOKIE)?.value).toBe('');
  });

  it('★ without the app’s cookie: the website’s callback, unchanged', async () => {
    const response = await get();
    expect(response.headers.get('location')).toBe('https://dev.gotcha.co.il/inbox');
  });
});
