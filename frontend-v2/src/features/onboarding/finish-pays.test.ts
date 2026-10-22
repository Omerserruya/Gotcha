import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Go live on a workspace that owes payment: the answer names the payment page
 * in the language the person finished setup in - the checkout's Hebrew page
 * for a Hebrew setup, not a redirect that guesses.
 */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const paymentPath = vi.hoisted(() => vi.fn(async (locale: string) => `/${locale}/checkout`));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('@/api/client/payment-path', () => ({ paymentPath }));
vi.mock('./discover-after', () => ({ discoverAfterResponse: vi.fn() }));
vi.mock('./load-onboarding', () => ({ loadDiscovery: vi.fn(), loadReading: vi.fn() }));

const { finishOnboarding } = await import('./onboarding-actions');

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  paymentPath.mockClear();
  get.mockResolvedValue({ data: { businessProfileCompleted: true } });
});

describe('★ Go live that owes payment: the payment page, in this language', () => {
  it('Hebrew setup: the Hebrew checkout', async () => {
    post.mockResolvedValue({ data: { status: 'PENDING_PAYMENT', paymentRequired: true } });
    const done = await finishOnboarding({ skippedCore: false, locale: 'he' });
    expect(paymentPath).toHaveBeenCalledWith('he');
    expect(done).toMatchObject({ ok: true, payAt: '/he/checkout' });
  });

  it('nothing owed: no payment page asked for', async () => {
    post.mockResolvedValue({ data: { status: 'ACTIVE', paymentRequired: false } });
    expect(await finishOnboarding({ skippedCore: false, locale: 'en' })).toMatchObject({
      ok: true,
      payAt: null,
    });
    expect(paymentPath).not.toHaveBeenCalled();
  });
});
