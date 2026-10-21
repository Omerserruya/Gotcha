import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ⚠ Mocked - nothing is sent: a coupon changes what a customer is charged. */
const { api, writes } = vi.hoisted(() => ({
  api: { post: vi.fn(), delete: vi.fn() },
  writes: { on: true },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { assignTenantCoupon, revokeTenantCoupon } from './coupon-actions';

beforeEach(() => {
  api.post.mockReset();
  api.delete.mockReset();
  writes.on = true;
});

describe('★★ a tenant’s coupons at the wire', () => {
  it('★★ held unless BILLING_WRITES=on, before any call', async () => {
    writes.on = false;
    expect(await assignTenantCoupon('t1', 'c1', null)).toEqual({ ok: false, reason: 'held' });
    expect(await revokeTenantCoupon('a1')).toEqual({ ok: false, reason: 'held' });
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('★ give: the coupon by id and the months, null for the coupon’s own window', async () => {
    api.post.mockResolvedValue({ assignment: { id: 'a1' } });
    expect(await assignTenantCoupon('t1', 'c1', 6)).toEqual({ ok: true });
    await assignTenantCoupon('t1', 'c1', null);
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/admin/coupons/tenants/t1' },
      body: { couponId: 'c1', durationMonths: 6 },
    });
    expect(api.post.mock.calls[1]![0].body).toEqual({ couponId: 'c1', durationMonths: null });
  });

  it('★ revoke: DELETE on the assignment', async () => {
    api.delete.mockResolvedValue({ assignment: { id: 'a1' } });
    expect(await revokeTenantCoupon('a1')).toEqual({ ok: true });
    expect(api.delete.mock.calls[0]![0].endpoint.path).toBe('/api/admin/coupons/assignments/a1');
  });

  it('★ the route’s refusal codes come back as themselves; others are forbidden or failed', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 400, developerMessage: 'already_assigned' }),
    );
    expect(await assignTenantCoupon('t1', 'c1', null)).toEqual({
      ok: false,
      reason: 'already_assigned',
    });
    api.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'authorization',
        status: 403,
        developerMessage: 'Platform administrator access required',
      }),
    );
    expect(await assignTenantCoupon('t1', 'c1', null)).toEqual({ ok: false, reason: 'forbidden' });
    api.delete.mockRejectedValueOnce(
      new ApiError({ kind: 'server', status: 500, developerMessage: 'coupon_operation_failed' }),
    );
    expect(await revokeTenantCoupon('a1')).toEqual({ ok: false, reason: 'failed' });
  });
});
