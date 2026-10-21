import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * The tenant writes at the wire. ⚠ Mocked - nothing is sent: these routes
 * provision real checkouts and email real customers.
 */
const { api, writes, signIn } = vi.hoisted(() => ({
  api: { post: vi.fn(), patch: vi.fn() },
  writes: { on: true },
  signIn: vi.fn(async () => {}),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: signIn }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import {
  assignPaidPlan,
  renameTenant,
  repairBilling,
  resendOnboarding,
  resendPaymentLink,
  setTenantActive,
} from './actions';

/** The route's refusal: its `error` string is what the client keeps as `developerMessage`. */
const refuse = (
  mock: ReturnType<typeof vi.fn>,
  status: number,
  error: string,
  extra: object = {},
) =>
  mock.mockRejectedValueOnce(
    new ApiError({
      kind:
        status === 409
          ? 'conflict'
          : status === 429
            ? 'rate_limited'
            : status === 403
              ? 'authorization'
              : status === 404
                ? 'not_found'
                : status === 400
                  ? 'validation'
                  : 'server',
      status,
      developerMessage: error,
      ...extra,
    }),
  );

beforeEach(() => {
  api.post.mockReset();
  api.patch.mockReset();
  signIn.mockClear();
  writes.on = true;
});

describe('★★ billing writes are held unless BILLING_WRITES=on - before any call', () => {
  it.each([
    ['repair', () => repairBilling('t1')],
    ['resend payment link', () => resendPaymentLink('t1')],
    ['assign a paid plan', () => assignPaidPlan('t1', 'pv1')],
  ])('%s', async (_name, write) => {
    writes.on = false;
    expect(await write()).toEqual({ ok: false, reason: 'held' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('not a billing write: enabling a tenant is not held', async () => {
    writes.on = false;
    api.patch.mockResolvedValue({ id: 't1' });
    expect(await setTenantActive('t1', true)).toEqual({ ok: true });
  });
});

describe('★★ repair billing setup', () => {
  it('★ POSTs to the tenant’s repair route and says whether the email went', async () => {
    api.post.mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
      r.payload.parse({ repaired: true, billing: { mode: 'PAID_PLAN', emailSent: false } }),
    );
    expect(await repairBilling('t1')).toEqual({ ok: true, emailSent: false });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/system/tenants/t1/repair-billing-provisioning' },
    });
  });

  it('a POC repair sends no email field: unknown, not "not sent"', async () => {
    api.post.mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
      r.payload.parse({ repaired: true, billing: { mode: 'POC', credits: 5000 } }),
    );
    expect(await repairBilling('t1')).toEqual({ ok: true, emailSent: null });
  });

  it('★ each refusal is its own reason', async () => {
    refuse(api.post, 409, 'NO_PROVISIONING_REQUEST');
    expect(await repairBilling('t1')).toMatchObject({ reason: 'no_request' });
    refuse(api.post, 409, 'TENANT_NOT_PENDING_PAYMENT');
    expect(await repairBilling('t1')).toMatchObject({ reason: 'not_pending_payment' });
    refuse(api.post, 409, 'BILLING_PROVISIONING_ALREADY_COMPLETE');
    expect(await repairBilling('t1')).toMatchObject({ reason: 'already_complete' });
    refuse(api.post, 502, 'BILLING_PROVISIONING_FAILED');
    expect(await repairBilling('t1')).toMatchObject({ reason: 'provisioning_failed' });
  });
});

describe('★★ resend the payment link', () => {
  it('★ says who it went to', async () => {
    api.post.mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
      r.payload.parse({ resent: true, sentTo: 'owner@acme.co', linkExpiresAt: 'x' }),
    );
    expect(await resendPaymentLink('t1')).toEqual({ ok: true, sentTo: 'owner@acme.co' });
    expect(api.post.mock.calls[0]![0].endpoint.path).toBe(
      '/api/system/tenants/t1/resend-payment-link',
    );
  });

  it('★ rate limited, with the route’s own wait', async () => {
    refuse(api.post, 429, 'PAYMENT_LINK_RATE_LIMITED', { retryAfterSeconds: 42 });
    expect(await resendPaymentLink('t1')).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 42,
    });
  });

  it('★ the prose refusals are matched too', async () => {
    refuse(api.post, 409, 'Tenant is not awaiting payment');
    expect(await resendPaymentLink('t1')).toMatchObject({ reason: 'not_pending_payment' });
    refuse(api.post, 409, 'Tenant has no administrator to send to');
    expect(await resendPaymentLink('t1')).toMatchObject({ reason: 'no_admin' });
    refuse(api.post, 409, 'BILLING_PROVISIONING_INCOMPLETE');
    expect(await resendPaymentLink('t1')).toMatchObject({ reason: 'setup_incomplete' });
    refuse(api.post, 400, 'PAYMENT_LINK_NOT_AVAILABLE');
    expect(await resendPaymentLink('t1')).toMatchObject({ reason: 'link_not_available' });
    refuse(api.post, 502, 'link_issued_but_email_failed');
    expect(await resendPaymentLink('t1')).toMatchObject({ reason: 'email_failed' });
  });
});

describe('★★ assign a paid plan', () => {
  it('★ sends the plan id and nothing else - the route prices it', async () => {
    api.post.mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
      r.payload.parse({ tenantStatus: 'PENDING_PAYMENT', billing: { emailSent: true } }),
    );
    expect(await assignPaidPlan('t1', 'pv1')).toEqual({ ok: true, emailSent: true });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/system/tenants/t1/assign-paid-plan' },
    });
    expect(api.post.mock.calls[0]![0].body).toEqual({ planVersionId: 'pv1' });
  });

  it('★ already has a plan; the plan is no longer offered', async () => {
    refuse(api.post, 409, 'TENANT_ALREADY_HAS_A_PLAN');
    expect(await assignPaidPlan('t1', 'pv1')).toMatchObject({ reason: 'already_has_plan' });
    refuse(api.post, 400, 'Invalid billing selection');
    expect(await assignPaidPlan('t1', 'pv1')).toMatchObject({ reason: 'invalid_plan' });
  });
});

describe('★ the tenant’s own writes', () => {
  it('enable and disable PATCH isActive', async () => {
    api.patch.mockResolvedValue({});
    await setTenantActive('t1', false);
    expect(api.patch.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/system/tenants/t1' },
      body: { isActive: false },
    });
  });

  it('rename sends the trimmed name; an empty one is not sent', async () => {
    api.patch.mockResolvedValue({});
    await renameTenant('t1', '  Acme Ltd ');
    expect(api.patch.mock.calls[0]![0].body).toEqual({ name: 'Acme Ltd' });
    expect(await renameTenant('t1', '   ')).toEqual({ ok: false, reason: 'failed' });
    expect(api.patch).toHaveBeenCalledTimes(1);
  });

  it('★ resend onboarding: who it went to, and the awaiting-payment refusal', async () => {
    api.post.mockImplementation(async (r: { payload: { parse: (v: unknown) => unknown } }) =>
      r.payload.parse({ message: 'ok', sentTo: 'admin@acme.co' }),
    );
    expect(await resendOnboarding('t1')).toEqual({ ok: true, sentTo: 'admin@acme.co' });
    refuse(api.post, 409, 'TENANT_AWAITING_PAYMENT');
    expect(await resendOnboarding('t1')).toMatchObject({ reason: 'awaiting_payment' });
    refuse(api.post, 400, 'Tenant has already completed onboarding');
    expect(await resendOnboarding('t1')).toMatchObject({ reason: 'already_onboarded' });
  });
});

describe('★★ failures', () => {
  it('★ a 401 goes to sign-in first', async () => {
    const cause = new ApiError({ kind: 'authentication', status: 401 });
    api.post.mockRejectedValueOnce(cause);
    await repairBilling('t1');
    expect(signIn).toHaveBeenCalledWith(cause);
  });

  it('403 is forbidden, 404 not found, anything else "failed" - never "nothing happened"', async () => {
    refuse(api.patch, 403, 'System admin access required');
    expect(await setTenantActive('t1', true)).toMatchObject({ reason: 'forbidden' });
    refuse(api.patch, 404, 'Tenant not found');
    expect(await setTenantActive('t1', true)).toMatchObject({ reason: 'not_found' });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'contract' }));
    expect(await repairBilling('t1')).toEqual({ ok: false, reason: 'failed' });
  });
});
