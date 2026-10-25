import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The WooCommerce plugin's "Connect to GOTCHA" (prod, 2026-10-25) landed on
 * the provider's page from `/connect`. Was it a page the proxy does not renew
 * the session for - a layout left holding an expired access token, which
 * `activeSession` cannot refresh in a render?
 *
 * No: `/connect` is renewed exactly like the product's pages, and the render
 * reads the renewed cookie from the request. These pin that, so a new route
 * group added to the public list cannot quietly become the gap.
 */

const now = 1_800_000_000;
const expiring = { sid: 's1', exp: now + 30, abs: now + 86_400 };
const refreshed = { sid: 's1', exp: now + 3_600, abs: now + 86_400 };

const refreshSession = vi.hoisted(() => vi.fn());
vi.mock('@/auth/refresh', () => ({ refreshSession }));
vi.mock('@/auth/session', () => ({
  nowInSeconds: () => now,
  unsealSession: async (value: string | undefined) => (value === 'old' ? expiring : null),
  sealSession: async () => 'new',
  sessionCookieOptions: () => ({
    name: 'gotcha_session',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 86_400,
  }),
}));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse: Response } = await import('next/server');
  return { default: () => () => Response.next() };
});

const { gate, renew } = await import('./proxy');

const at = (path: string) =>
  new NextRequest(`https://app.gotcha.co.il${path}`, { headers: { cookie: 'gotcha_session=old' } });

const CONNECT = '/he/connect/woocommerce?site=https%3A%2F%2Fshop.example&return=x&nonce=n';

beforeEach(() => {
  refreshSession.mockReset();
});

describe('★★ /connect renews an expiring session like any product page', () => {
  it('★ an access token about to expire is refreshed on the way in', async () => {
    refreshSession.mockResolvedValue(refreshed);
    const renewal = await renew(at(CONNECT));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(renewal).toMatchObject({ kind: 'renewed', sealed: 'new' });
  });

  it('★★ and the render gets the renewed cookie, the browser keeps it', async () => {
    refreshSession.mockResolvedValue(refreshed);
    const request = at(CONNECT);
    const response = gate(request, await renew(request));
    // The layout's `activeSession()` reads the request's cookie: the new one.
    expect(response.headers.get('x-middleware-request-cookie')).toContain('gotcha_session=new');
    expect(response.cookies.get('gotcha_session')?.value).toBe('new');
  });

  it('a refused refresh says "ended" on the way to OUR screen', async () => {
    refreshSession.mockResolvedValue(null);
    const request = at(CONNECT);
    const response = gate(request, await renew(request));
    const target = new URL(response.headers.get('location') ?? '');
    expect(target.pathname).toBe('/he/sign-in');
    expect(target.searchParams.get('error')).toBe('ended');
    expect(target.searchParams.get('returnTo')).toBe(CONNECT);
  });

  it('the same as the product does (one rule, not two)', async () => {
    refreshSession.mockResolvedValue(refreshed);
    expect((await renew(at('/he/settings/channels/website'))).kind).toBe('renewed');
    expect((await renew(at(CONNECT))).kind).toBe('renewed');
  });
});
