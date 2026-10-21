/*
 * @vitest-environment node
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerEnvCache } from '@/config/env.server';

/**
 * The session is renewed in the proxy, before the render - the one place a
 * cookie can be written AND the render can be handed the new token.
 */
const refreshSession = vi.hoisted(() => vi.fn());
vi.mock('@/auth/refresh', () => ({ refreshSession }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  // `localePrefix: 'always'` passes an already-prefixed path straight through.
  return {
    default: () => (request: NextRequest) =>
      NextResponse.next({ request: { headers: new Headers(request.headers) } }),
  };
});

const { default: proxy, RENEW_AHEAD_SECONDS } = await import('./proxy');
const { sealSession, unsealSession } = await import('@/auth/session');

const NAME = 'gotcha_session';
const now = () => Math.floor(Date.now() / 1000);
const base = { sub: 's', sid: 'sid', at: 'at-old', rt: 'rt-old', abs: now() + 30 * 86400 };

const request = async (exp: number, path = '/en/home') =>
  new NextRequest(`https://dev.gotcha.co.il${path}`, {
    headers: { cookie: `${NAME}=${await sealSession({ ...base, exp })}; other=1` },
  });

/** The cookie the render will read: Next's forwarded request header. */
const forwardedCookie = (response: Response) =>
  response.headers.get('x-middleware-request-cookie') ?? '';

beforeEach(() => {
  process.env.SESSION_SECRET = 'x'.repeat(48);
  process.env.SESSION_COOKIE_NAME = NAME;
  process.env.API_BASE_URL = 'http://localhost';
  process.env.APP_ORIGIN = 'https://dev.gotcha.co.il';
  process.env.OIDC_ISSUER = 'https://auth.example/application/o/gotcha/';
  process.env.OIDC_CLIENT_ID = 'gotcha-app';
  resetServerEnvCache();
  refreshSession.mockReset();
});
afterEach(() => {
  resetServerEnvCache();
});

describe('★★ the proxy renews the session before the render', () => {
  it('a token with time left: nothing spent, no cookie written', async () => {
    const response = await proxy(await request(now() + RENEW_AHEAD_SECONDS + 60));
    expect(refreshSession).not.toHaveBeenCalled();
    expect(response.cookies.get(NAME)).toBeUndefined();
  });

  it('★★ near expiry: the browser gets the NEW refresh token, and so does this render', async () => {
    refreshSession.mockImplementation(async (s: { rt: string }) => ({
      ...base,
      at: 'at-new',
      rt: 'rt-new',
      exp: now() + 1800,
      ...(s.rt === 'rt-old' ? {} : { rt: 'wrong' }),
    }));
    const response = await proxy(await request(now() + 30));
    expect(refreshSession).toHaveBeenCalledTimes(1);

    const sealed = response.cookies.get(NAME);
    expect(sealed?.httpOnly).toBe(true);
    expect(sealed?.path).toBe('/');
    expect((await unsealSession(sealed?.value))?.rt).toBe('rt-new');

    // The render reads the request: it must carry the same, not the spent one.
    const forwarded = forwardedCookie(response);
    const value = /gotcha_session=([^;]+)/.exec(forwarded)?.[1];
    expect((await unsealSession(value))?.at).toBe('at-new');
    expect(forwarded).toContain('other=1');
  });

  it('★★ refused at the identity provider: the cookie is cleared and it is sign-in, with the way back', async () => {
    refreshSession.mockResolvedValue(null);
    const response = await proxy(await request(now() - 10, '/en/approvals?x=1'));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toMatch(/\/sign-in$/);
    expect(location.searchParams.get('returnTo')).toBe('/en/approvals?x=1');
    expect(response.cookies.get(NAME)?.value).toBe('');
    // ★ And the screen says why: "Your session ended".
    expect(location.searchParams.get('error')).toBe('ended');
  });

  it('★★ ended, with another session cookie letting the request through: the render is told', async () => {
    /*
     * Dev: a /he/ page with a refused refresh landed on /en/sign-in with no
     * reason - another `*_session` cookie passed the gate, and the layout's
     * sign-in did not know the session had ENDED. The render now does.
     */
    refreshSession.mockResolvedValue(null);
    const ended = await request(now() - 10, '/he/studio/automations');
    ended.cookies.set('platform_session', 'other');
    const response = await proxy(ended);
    expect(response.headers.get('x-middleware-request-x-gotcha-session-ended')).toBe('1');
  });

  it('a browser cannot claim "ended" itself', async () => {
    const response = await proxy(
      new NextRequest('https://dev.gotcha.co.il/en/home', {
        headers: {
          cookie: `${NAME}=${await sealSession({ ...base, exp: now() + 3600 })}`,
          'x-gotcha-session-ended': '1',
        },
      }),
    );
    expect(response.headers.get('x-middleware-request-x-gotcha-session-ended')).toBeNull();
  });

  it('never signed in is not "ended": no reason on the way to sign-in', async () => {
    const response = await proxy(new NextRequest('https://dev.gotcha.co.il/en/home'));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBeNull();
  });

  it('every page render is told where it is, for a sign-in from the layout', async () => {
    const response = await proxy(await request(now() + 3600, '/en/inbox?c=1'));
    expect(response.headers.get('x-middleware-request-x-gotcha-return-to')).toBe('/en/inbox?c=1');
    // Next forwards only the headers this list names: ours, not next-intl's copy.
    const forwarded = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
    expect(forwarded).toEqual(expect.arrayContaining(['x-gotcha-return-to', 'x-nonce', 'cookie']));
  });

  it('the sign-in screen itself is never renewed', async () => {
    await proxy(await request(now() - 10, '/en/sign-in'));
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe('★★ a link to the old app is redirected BEFORE the session is renewed', () => {
  it('near expiry on a legacy URL: nothing refreshed, so no rotated token can be dropped', async () => {
    refreshSession.mockResolvedValue({ ...base, at: 'at-new', rt: 'rt-new', exp: now() + 3600 });
    const response = await proxy(await request(now() + 10, '/conversations/c1'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://dev.gotcha.co.il/inbox?c=c1');
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
