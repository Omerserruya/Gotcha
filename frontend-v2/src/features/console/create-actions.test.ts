import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * Creating a tenant and quoting its plan, at the wire. ⚠ Mocked - nothing is
 * sent: a paid tenant provisions a real checkout and emails a real person.
 */
const { api, writes } = vi.hoisted(() => ({
  api: { post: vi.fn() },
  writes: { on: true },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { createTenant, quoteProvisioning, type NewTenant } from './create-actions';

const paid: NewTenant = {
  name: 'Acme',
  slug: 'acme',
  adminEmail: 'owner@acme.co',
  adminName: 'Dana',
  billing: {
    mode: 'PAID_PLAN',
    planVersionId: 'pv1',
    chatVolumeOptionKey: 'chat_50',
    voiceVolumeOptionKey: null,
  },
};
const poc: NewTenant = {
  ...paid,
  billing: {
    mode: 'POC',
    pocCredits: 5000,
    pocExpiresAt: '2026-12-31T23:59:59.000Z',
    pocFeatureAreas: ['ai', 'conversation'],
  },
};
const created = { tenant: { id: 't9', name: 'Acme', slug: 'acme', status: 'PENDING_PAYMENT' } };
const parseWith = (body: unknown) =>
  api.post.mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
    r.payload.parse(body),
  );

beforeEach(() => {
  api.post.mockReset();
  writes.on = true;
});

describe('★★ createTenant', () => {
  it('★★ a PAID tenant is held unless BILLING_WRITES=on, before any call', async () => {
    writes.on = false;
    expect(await createTenant(paid)).toEqual({ ok: false, reason: 'held' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('★ a POC moves no money: not held', async () => {
    writes.on = false;
    parseWith({ ...created, billing: { mode: 'POC' } });
    expect(await createTenant(poc)).toEqual({ ok: true, tenantId: 't9' });
  });

  it('★ POSTs the form as the route takes it: keys only, no price', async () => {
    parseWith(created);
    expect(await createTenant(paid)).toEqual({ ok: true, tenantId: 't9' });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/system/tenants' },
      body: paid,
    });
  });

  it('★★ a 502 is "created, billing incomplete" with the tenant - never "create it again"', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'server',
        status: 502,
        developerMessage: 'Tenant created but plan setup did not complete',
        code: 'provisioning_failed',
        errorData: { tenant: { id: 't9', name: 'Acme' }, billing: { canRepair: true } },
      }),
    );
    expect(await createTenant(paid)).toEqual({
      ok: false,
      reason: 'setup_incomplete',
      tenantId: 't9',
    });
  });

  it('★ each refusal its own reason', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'conflict',
        status: 409,
        developerMessage: 'A tenant with this slug already exists',
      }),
    );
    expect(await createTenant(paid)).toMatchObject({ reason: 'slug_taken' });
    api.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'Invalid billing selection',
        code: 'expiry_must_be_in_the_future',
      }),
    );
    expect(await createTenant(poc)).toMatchObject({ reason: 'expiry_past' });
    api.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'Invalid billing selection',
        code: 'unknown_feature_domain',
      }),
    );
    expect(await createTenant(poc)).toMatchObject({ reason: 'unknown_domain' });
    api.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'Invalid billing selection',
        code: 'plan_version_not_active',
      }),
    );
    expect(await createTenant(paid)).toMatchObject({ reason: 'invalid_billing' });
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 400, developerMessage: 'Validation failed' }),
    );
    expect(await createTenant(paid)).toMatchObject({ reason: 'invalid' });
  });

  it('★ a 500 or a timeout is "could not confirm" - it may have been created', async () => {
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'timeout' }));
    expect(await createTenant(poc)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('★ quoteProvisioning', () => {
  it('asks for the selection by key and reads the server’s figures', async () => {
    parseWith({
      planName: 'Growth',
      basePrice: '499',
      totalAmount: '599.00',
      currency: 'ILS',
      includedCredits: 10000,
      estimatedChatsMonthly: 1100,
      estimatedCallsMonthly: 0,
      billingInterval: 'MONTHLY',
      chargeableToday: true,
    });
    const result = await quoteProvisioning({
      planVersionId: 'pv1',
      chatVolumeOptionKey: 'chat_50',
      voiceVolumeOptionKey: null,
    });
    expect(result).toMatchObject({ ok: true, quote: { totalAmount: '599.00', currency: 'ILS' } });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/admin/pricing/provisioning/quote' },
      body: { planVersionId: 'pv1', chatVolumeOptionKey: 'chat_50', voiceVolumeOptionKey: null },
    });
  });

  it('the route’s codes: a plan gone, a volume invalid', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'plan_version_not_active',
      }),
    );
    expect(
      await quoteProvisioning({
        planVersionId: 'x',
        chatVolumeOptionKey: null,
        voiceVolumeOptionKey: null,
      }),
    ).toEqual({
      ok: false,
      reason: 'plan_gone',
    });
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 400, developerMessage: 'volume_option_invalid' }),
    );
    expect(
      await quoteProvisioning({
        planVersionId: 'x',
        chatVolumeOptionKey: 'y',
        voiceVolumeOptionKey: null,
      }),
    ).toEqual({
      ok: false,
      reason: 'volume_invalid',
    });
  });
});
