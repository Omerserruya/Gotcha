import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ NOTHING HERE REACHES BILLING
 * ════════════════════════════════════════════════════════════════════════════
 * `payment-session` writes at the provider and `advance` may charge a stored
 * card; dev's billing is the live payment account. `serverApi` is a spy for
 * this whole file, and BILLING_WRITES is the test's switch.
 */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const jar = vi.hoisted(
  () => new Map<string, { value: string; options?: Record<string, unknown> }>(),
);
const writes = vi.hoisted(() => ({ on: true }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({ get, post }),
  platformHeaders: async () => ({}),
}));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) =>
      jar.set(name, { value, options }),
  }),
}));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

const { openCheckout, resendWelcome, startCheckoutPayment, watchCheckout } =
  await import('./actions');

const summary = (status: string) => ({ reference: 'chk_1', status });
/** What billing's status route answers a first token hop with (`checkout-auth.ts:69`). */
const billingSetsCookie =
  (value: string, maxAge = 3600) =>
  (request: { onResponseHeaders?: (headers: Headers) => void }) => {
    const headers = new Headers();
    headers.append(
      'set-cookie',
      `gc_co_chk_1=${encodeURIComponent(value)}; Path=/api/checkout; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`,
    );
    request.onResponseHeaders?.(headers);
    return Promise.resolve(summary('PAYMENT_REQUIRED'));
  };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  jar.clear();
  writes.on = true;
});

describe('★★ the emailed link: the token proved once, then kept where no script reads it', () => {
  it('kept in an HttpOnly cookie, with billing’s own lifetime, and the page named', async () => {
    get.mockImplementation(billingSetsCookie('tok_123', 7200));
    expect(await openCheckout('chk_1', 'tok_123')).toEqual({ ok: true, page: 'payment-required' });
    expect(get.mock.calls[0]![0].query).toEqual({ token: 'tok_123' });
    const kept = jar.get('gotcha_co_chk_1');
    expect(kept?.value).toBe('tok_123');
    expect(kept?.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7200,
    });
  });

  it('billing hands no cookie: nothing kept, the page still named', async () => {
    get.mockResolvedValue(summary('COMPLETED'));
    expect(await openCheckout('chk_1', 'tok_123')).toEqual({ ok: true, page: 'completed' });
    expect(jar.size).toBe(0);
  });

  it('a refused token: not ok, nothing kept', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await openCheckout('chk_1', 'tok_bad')).toEqual({ ok: false });
    expect(jar.size).toBe(0);
  });

  it('not a reference: nothing asked', async () => {
    expect(await openCheckout('../x', 'tok')).toEqual({ ok: false });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('★★ Set up payment', () => {
  it('held (BILLING_WRITES off): refused before any request', async () => {
    writes.on = false;
    expect(await startCheckoutPayment('chk_1')).toEqual({ ok: false, kind: 'held' });
    expect(post).not.toHaveBeenCalled();
  });

  it('billing’s https page, with the held token in the body', async () => {
    jar.set('gotcha_co_chk_1', { value: 'tok_held' });
    post.mockResolvedValue({ redirectUrl: 'https://pay.example/session' });
    expect(await startCheckoutPayment('chk_1')).toEqual({
      ok: true,
      url: 'https://pay.example/session',
    });
    expect(post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/checkout/chk_1/payment-session' },
      body: { token: 'tok_held' },
    });
  });

  it('a member, no token: an empty body', async () => {
    post.mockResolvedValue({ redirectUrl: 'https://pay.example/session' });
    await startCheckoutPayment('chk_1');
    expect(post.mock.calls[0]![0].body).toEqual({});
  });

  it('★ a destination that is not https is not followed', async () => {
    post.mockResolvedValue({ redirectUrl: 'http://pay.example/session' });
    expect(await startCheckoutPayment('chk_1')).toEqual({ ok: false, kind: 'failed' });
  });

  it('refused by billing (409 payment_setup_unavailable): failed', async () => {
    post.mockRejectedValue(new ApiError({ kind: 'conflict', status: 409 }));
    expect(await startCheckoutPayment('chk_1')).toEqual({ ok: false, kind: 'failed' });
  });
});

describe('★★ the waiting page’s poll', () => {
  it('asks billing to re-check, THEN reads - so the read is this check’s answer', async () => {
    const order: string[] = [];
    post.mockImplementation(async () => (order.push('advance'), { phase: 'PAID' }));
    get.mockImplementation(async () => (order.push('status'), summary('COMPLETED')));
    expect(await watchCheckout('chk_1')).toEqual({ kind: 'ready', summary: summary('COMPLETED') });
    expect(order).toEqual(['advance', 'status']);
    expect(post.mock.calls[0]![0].endpoint.path).toBe('/api/checkout/chk_1/advance');
  });

  it('★ held: never advances (it may charge) - only reads', async () => {
    writes.on = false;
    get.mockResolvedValue(summary('PROCESSING'));
    expect(await watchCheckout('chk_1')).toEqual({ kind: 'ready', summary: summary('PROCESSING') });
    expect(post).not.toHaveBeenCalled();
  });

  it('a failed advance still reads where things stand', async () => {
    post.mockRejectedValue(new ApiError({ kind: 'server', status: 500 }));
    get.mockResolvedValue(summary('PROCESSING'));
    expect(await watchCheckout('chk_1')).toEqual({ kind: 'ready', summary: summary('PROCESSING') });
  });
});

describe('the welcome email again', () => {
  it('sent: said so', async () => {
    post.mockResolvedValue({ sent: true });
    expect(await resendWelcome('chk_1')).toEqual({ sent: true });
    expect(post.mock.calls[0]![0].endpoint.path).toBe('/api/checkout/chk_1/resend-welcome');
  });

  it('refused: not sent, never a throw', async () => {
    post.mockRejectedValue(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await resendWelcome('chk_1')).toEqual({ sent: false });
  });
});
