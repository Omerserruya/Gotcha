import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* Go-live and the sandboxed test, at the wire. ⚠ Mocked: nothing goes live, nothing is asked. */
const { api, warn } = vi.hoisted(() => ({ api: { post: vi.fn() }, warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn(async () => {}) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/api/client/payment-path', () => ({
  paymentPath: async (locale: string) => `/${locale}/checkout/payment-required?ref=r1`,
}));

import { employeeTestSchema, goLiveSchema } from '@/api/contracts/onboarding-v2';

import { askEmployee, goLive } from './live-actions';

beforeEach(() => {
  api.post.mockReset();
  warn.mockClear();
});

describe('★★ the press', () => {
  it('POST /go-live with confirm, and the name only when one was typed (trimmed)', async () => {
    const live = goLiveSchema.parse({ employee: { id: 'a1', name: 'Noa', status: 'ACTIVE' } });
    api.post.mockResolvedValue(live);
    expect(await goLive(' Noa ')).toEqual({ ok: true, live });
    const call = api.post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/onboarding/go-live');
    expect(call.body).toEqual({ confirm: true, employeeName: 'Noa' });
    expect(call.payload).toBe(goLiveSchema);
    await goLive('   ');
    expect(api.post.mock.calls[1]![0].body).toEqual({ confirm: true });
  });

  it.each([
    ['NOT_LEARNED', 'not_learned'],
    ['TENANT_SUSPENDED', 'suspended'],
    ['NO_ACTIVE_ADMIN', 'no_admin'],
    ['GO_LIVE_FAILED', 'failed'],
  ])(
    '★ %s reads as %s (by code, whatever kind the client filed it under)',
    async (code, reason) => {
      api.post.mockRejectedValue(
        new ApiError({
          kind: code.startsWith('TENANT_') ? 'tenant_inactive' : 'conflict',
          status: 409,
          code,
        }),
      );
      expect(await goLive('')).toEqual({ ok: false, reason });
    },
  );

  it('★★ awaiting payment: where it pays, in the interface language', async () => {
    api.post.mockRejectedValue(
      new ApiError({ kind: 'tenant_inactive', status: 409, code: 'TENANT_AWAITING_PAYMENT' }),
    );
    expect(await goLive('')).toEqual({
      ok: false,
      reason: 'awaiting_payment',
      payAt: '/he/checkout/payment-required?ref=r1',
    });
  });

  it('a network failure is failed, and logged', async () => {
    api.post.mockRejectedValue(new ApiError({ kind: 'network' }));
    expect(await goLive('')).toEqual({ ok: false, reason: 'failed' });
    expect(warn).toHaveBeenCalledWith('onboarding.go_live_failed', expect.anything());
  });
});

describe('★★ the sandboxed test', () => {
  it('POST the trimmed question to the employee test route', async () => {
    const test = employeeTestSchema.parse({ answer: 'Shipped.' });
    api.post.mockResolvedValue(test);
    expect(await askEmployee(' Where is my order? ')).toEqual({ ok: true, test });
    const call = api.post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/ai-assist/onboarding-employee-test');
    expect(call.body).toEqual({ question: 'Where is my order?' });
  });

  it.each([
    ['NOT_LIVE', 409, 'not_live'],
    ['QUESTION_REQUIRED', 422, 'question_required'],
    ['QUESTION_TOO_LONG', 422, 'too_long'],
    ['EMPLOYEE_TEST_FAILED', 500, 'failed'],
  ])('★ %s reads as %s', async (code, status, reason) => {
    api.post.mockRejectedValue(new ApiError({ kind: 'conflict', status, code }));
    expect(await askEmployee('q')).toEqual({ ok: false, reason });
  });

  it('★ rate limited carries when to try again', async () => {
    api.post.mockRejectedValue(
      new ApiError({
        kind: 'rate_limited',
        status: 429,
        code: 'PREVIEW_RATE_LIMITED',
        retryAfterSeconds: 20,
      }),
    );
    expect(await askEmployee('q')).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 20,
    });
  });
});
