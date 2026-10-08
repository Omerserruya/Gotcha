import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const api = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { saveBillingProfile } from './actions';

const DETAILS = {
  billingName: ' Aviv Ltd ',
  vatId: '',
  billingAddress: 'Tel Aviv',
  billingCountry: 'il',
  billingEmail: 'finance@example.com',
};

beforeEach(() => {
  api.put.mockReset();
});

describe('★★ 17e Save at the wire - PUT /billing/profile, every field', () => {
  it('sends all five, trimmed, the country upper-cased; an empty one as empty', async () => {
    api.put.mockResolvedValue({});
    expect(await saveBillingProfile(DETAILS)).toEqual({ ok: true });
    const request = api.put.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(request.endpoint.path).toBe('/api/billing/profile');
    expect(request.body).toEqual({
      billingName: 'Aviv Ltd',
      vatId: '',
      billingAddress: 'Tel Aviv',
      billingCountry: 'IL',
      billingEmail: 'finance@example.com',
    });
  });

  it('a country that is not two letters is refused before any call (it selects a tax rate)', async () => {
    expect(await saveBillingProfile({ ...DETAILS, billingCountry: 'Isr' })).toEqual({
      ok: false,
      reason: 'invalid_country',
    });
    expect(api.put).not.toHaveBeenCalled();
  });

  it('409 is no record yet; 403 forbidden; 400 the country; else failed', async () => {
    api.put.mockRejectedValueOnce(new ApiError({ kind: 'conflict', status: 409 }));
    expect(await saveBillingProfile(DETAILS)).toEqual({ ok: false, reason: 'no_record' });
    api.put.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await saveBillingProfile(DETAILS)).toEqual({ ok: false, reason: 'forbidden' });
    api.put.mockRejectedValueOnce(new ApiError({ kind: 'validation', status: 400 }));
    expect(await saveBillingProfile(DETAILS)).toEqual({ ok: false, reason: 'invalid_country' });
    api.put.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await saveBillingProfile(DETAILS)).toEqual({ ok: false, reason: 'failed' });
  });
});
