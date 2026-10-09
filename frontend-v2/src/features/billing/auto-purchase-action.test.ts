import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const put = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
const writes = vi.hoisted(() => ({ on: true }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));

import { saveAutoPurchase } from './actions';

const INPUT = {
  enabled: true,
  thresholdPct: 15,
  packageKey: 'p5000',
  maxMonthlySpend: null,
  limitBehavior: 'HUMAN_ONLY' as const,
  warningThresholdPct: 70,
  incrementCredits: 500,
  pricePerCredit: '0.012000',
};

beforeEach(() => {
  put.mockReset();
  writes.on = true;
});

describe('★★ 17c Save at the wire - every field, and refused before any request when writes are off', () => {
  it('off: held, nothing sent', async () => {
    writes.on = false;
    expect(await saveAutoPurchase(INPUT)).toEqual({ ok: false, reason: 'held' });
    expect(put).not.toHaveBeenCalled();
  });

  it('PUT /billing/auto-purchase with all eight fields - "no limit" sent as null, never omitted', async () => {
    put.mockResolvedValue({});
    expect(await saveAutoPurchase(INPUT)).toEqual({ ok: true });
    const request = put.mock.calls[0]![0] as { endpoint: { path: string }; body: object };
    expect(request.endpoint.path).toBe('/api/billing/auto-purchase');
    expect(request.body).toEqual(INPUT);
    expect(request.body).toHaveProperty('maxMonthlySpend', null);
  });

  it('402 is the plan; 400 invalid; 403 forbidden; else failed', async () => {
    put.mockRejectedValueOnce(new ApiError({ kind: 'tenant_inactive', status: 402 }));
    expect(await saveAutoPurchase(INPUT)).toEqual({ ok: false, reason: 'plan' });
    put.mockRejectedValueOnce(new ApiError({ kind: 'validation', status: 400 }));
    expect(await saveAutoPurchase(INPUT)).toEqual({ ok: false, reason: 'invalid' });
    put.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await saveAutoPurchase(INPUT)).toEqual({ ok: false, reason: 'forbidden' });
    put.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await saveAutoPurchase(INPUT)).toEqual({ ok: false, reason: 'failed' });
  });
});
