import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * Reading a checkout as whoever holds it. `serverApi` is a spy for the whole
 * file: nothing here reaches billing.
 */
const get = vi.hoisted(() => vi.fn());
const jar = vi.hoisted(() => new Map<string, string>());
const session = vi.hoisted(() => ({ value: null as null | { sid: string } }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({ get }),
  platformHeaders: async () => (session.value ? { authorization: 'Bearer at' } : {}),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

const { loadCheckout, loadMine, tokenCookieName } = await import('./load-checkout');

const SUMMARY = { reference: 'chk_1', status: 'PAYMENT_REQUIRED' };
const notFound = () => new ApiError({ kind: 'not_found', status: 404 });
const tokenOf = (call: unknown[]) => (call[0] as { query?: { token?: string } }).query?.token;

beforeEach(() => {
  get.mockReset();
  jar.clear();
  session.value = null;
});

describe('★★ the token, then the session - never a spent token alone', () => {
  it('a held token travels as ?token=, to the reference it was kept for', async () => {
    jar.set(tokenCookieName('chk_1'), 'tok_held');
    get.mockResolvedValue(SUMMARY);
    expect(await loadCheckout('chk_1')).toEqual({ kind: 'ready', summary: SUMMARY });
    expect(get.mock.calls[0]![0].endpoint.path).toBe('/api/checkout/chk_1/status');
    expect(tokenOf(get.mock.calls[0]!)).toBe('tok_held');
  });

  it('another checkout’s token is not sent', async () => {
    jar.set(tokenCookieName('chk_other'), 'tok_other');
    get.mockResolvedValue(SUMMARY);
    await loadCheckout('chk_1');
    expect(tokenOf(get.mock.calls[0]!)).toBeUndefined();
  });

  it('★ a refused token, signed in: asked again as the member', async () => {
    jar.set(tokenCookieName('chk_1'), 'tok_spent');
    session.value = { sid: 's' };
    get.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(SUMMARY);
    expect(await loadCheckout('chk_1')).toEqual({ kind: 'ready', summary: SUMMARY });
    expect(get).toHaveBeenCalledTimes(2);
    expect(tokenOf(get.mock.calls[1]!)).toBeUndefined();
  });

  it('a refused token, signed out: unavailable, asked once', async () => {
    jar.set(tokenCookieName('chk_1'), 'tok_spent');
    get.mockRejectedValue(notFound());
    expect(await loadCheckout('chk_1')).toEqual({ kind: 'unavailable' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a failure that is not a refusal is not retried', async () => {
    jar.set(tokenCookieName('chk_1'), 'tok');
    session.value = { sid: 's' };
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 503 }));
    expect(await loadCheckout('chk_1')).toEqual({ kind: 'unavailable' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('no reference: unavailable, nothing asked', async () => {
    expect(await loadCheckout(null)).toEqual({ kind: 'unavailable' });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('a member’s own outstanding checkout', () => {
  it('signed out: nobody to ask about - not asked', async () => {
    expect(await loadMine()).toEqual({ kind: 'none' });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [
      { data: { checkout: { reference: 'chk_9', expiresAt: 'x' } } },
      { kind: 'open', reference: 'chk_9' },
    ],
    [{ data: { checkout: null, expired: true } }, { kind: 'expired' }],
    [{ data: { checkout: null } }, { kind: 'none' }],
  ])('%j → %j', async (body, expected) => {
    session.value = { sid: 's' };
    get.mockResolvedValue(body);
    expect(await loadMine()).toEqual(expected);
    expect(get.mock.calls[0]![0]).toMatchObject({ raw: true });
  });

  it('unreadable: none', async () => {
    session.value = { sid: 's' };
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 500 }));
    expect(await loadMine()).toEqual({ kind: 'none' });
  });
});
