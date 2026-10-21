import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* GET /api/admin/coupons → bare { coupons } (admin-coupons.ts:63). Mocked. */
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { loadCoupons } from './load-coupons';

beforeEach(() => {
  api.get.mockReset();
});

describe('★ loadCoupons', () => {
  it('the list, through its schema', async () => {
    api.get.mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
      r.payload.parse({
        coupons: [
          {
            id: 'c1',
            code: 'LAUNCH20',
            nameEn: 'Launch',
            nameHe: null,
            discountType: 'PERCENT',
            percentOff: 20,
            amountOff: null,
            currency: null,
            defaultDurationMonths: 12,
            active: true,
            maxRedemptions: 5,
            redemptionCount: 2,
            assignmentCount: 2,
            internalNote: null,
            label: '20% off',
            createdAt: '2026-10-01T09:00:00.000Z',
          },
        ],
      }),
    );
    expect(await loadCoupons()).toEqual([
      expect.objectContaining({ code: 'LAUNCH20', maxRedemptions: 5, assignmentCount: 2 }),
    ]);
    expect(api.get.mock.calls[0]![0].endpoint.path).toBe('/api/admin/coupons');
  });

  it('★ a failed read is undefined, not an empty list', async () => {
    api.get.mockRejectedValue(new ApiError({ kind: 'server', status: 500 }));
    expect(await loadCoupons()).toBeUndefined();
  });
});
