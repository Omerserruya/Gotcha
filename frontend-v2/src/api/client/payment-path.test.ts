import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-error';

/**
 * Where the product's payment gate sends an unpaid workspace. It is a
 * `window.location` target, so nothing adds the locale or the mount point for
 * it: both are this function's, and a bare `/checkout/...` would cost a
 * redirect and lose the interface language.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

const load = async () => (await import('./payment-path')).paymentPath;

beforeEach(() => {
  get.mockReset();
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

describe('★★ the payment page, in this app and this language', () => {
  it('an open checkout: its payment page, locale first, the reference encoded', async () => {
    get.mockResolvedValue({ data: { checkout: { reference: 'chk_a b' } } });
    expect(await (await load())('he')).toBe('/he/checkout/payment-required?ref=chk_a%20b');
    expect(get.mock.calls[0]![0].endpoint.path).toBe('/api/checkout/mine');
  });

  it('none open: the entry page, which explains', async () => {
    get.mockResolvedValue({ data: { checkout: null } });
    expect(await (await load())('en')).toBe('/en/checkout');
  });

  it('billing unreadable: the entry page, never a throw', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 503 }));
    expect(await (await load())('en')).toBe('/en/checkout');
  });

  it('under a mount point: prefixed, since a plain navigation is not', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/v2');
    get.mockResolvedValue({ data: { checkout: { reference: 'chk_1' } } });
    expect(await (await load())('en')).toBe('/v2/en/checkout/payment-required?ref=chk_1');
  });
});
