import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* The manual edits at the wire. ⚠ Mocked: nothing is sent. */
const { api, signIn, warn } = vi.hoisted(() => ({
  api: { patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
  signIn: vi.fn(async () => {}),
  warn: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: signIn }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { manualEditSchema } from '@/api/contracts/console';

import {
  addMember,
  changeMemberEmail,
  deleteTenant,
  manualBillingEdit,
  removeMember,
  setTenantStatus,
} from './edit-actions';

beforeEach(() => {
  for (const each of Object.values(api)) each.mockReset();
  signIn.mockClear();
  warn.mockClear();
});

describe('★★ setting a tenant’s status by hand', () => {
  it('★★ PATCH /status with the status and the TRIMMED reason; the warnings come back', async () => {
    api.patch.mockResolvedValue({ warnings: ['no_access_source'] });
    expect(await setTenantStatus('t1', 'ACTIVE', '  paid by wire  ')).toEqual({
      ok: true,
      warnings: ['no_access_source'],
    });
    const call = api.patch.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/tenants/t1/status');
    expect(call.body).toEqual({ status: 'ACTIVE', reason: 'paid by wire' });
    expect(call.payload).toBe(manualEditSchema);
  });

  it('★ the answer is read leniently: no warnings, or unreadable ones, are none', () => {
    expect(manualEditSchema.parse({ before: 'X', after: 'Y' })).toEqual({ warnings: [] });
    expect(manualEditSchema.parse({ warnings: 'oops' })).toEqual({ warnings: [] });
    expect(manualEditSchema.parse(null)).toEqual({ warnings: [] });
  });

  it('★★ TENANT_NOT_FOUND is "no such tenant" - read by code, whatever kind the transport filed', async () => {
    // The transport files any TENANT_* code as tenant_inactive.
    api.patch.mockRejectedValue(
      new ApiError({ kind: 'tenant_inactive', status: 404, code: 'TENANT_NOT_FOUND' }),
    );
    expect(await setTenantStatus('t1', 'ACTIVE', 'r')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('★★ a validator 400 (no code) names the field: the reason, or another', async () => {
    api.patch.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'Validation failed',
        fieldErrors: [{ field: 'reason', message: 'Too long' }],
      }),
    );
    expect(await setTenantStatus('t1', 'ACTIVE', 'r')).toEqual({
      ok: false,
      reason: 'reason_invalid',
    });
    api.patch.mockRejectedValueOnce(
      new ApiError({
        kind: 'validation',
        status: 400,
        developerMessage: 'Validation failed',
        fieldErrors: [{ field: 'status', message: 'Invalid enum value' }],
      }),
    );
    expect(await setTenantStatus('t1', 'ACTIVE', 'r')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('403 is forbidden; anything else is failed, logged, never "nothing happened"', async () => {
    api.patch.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await setTenantStatus('t1', 'ACTIVE', 'r')).toEqual({ ok: false, reason: 'forbidden' });
    api.patch.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await setTenantStatus('t1', 'ACTIVE', 'r')).toEqual({ ok: false, reason: 'failed' });
    expect(warn).toHaveBeenCalledWith('console.tenant_status_failed', expect.anything());
  });

  it('a signed-out caller is sent to sign in', async () => {
    const cause = new ApiError({ kind: 'authentication', status: 401 });
    api.patch.mockRejectedValue(cause);
    await setTenantStatus('t1', 'ACTIVE', 'r');
    expect(signIn).toHaveBeenCalledWith(cause);
  });
});

const refuseWith = (
  mock: ReturnType<typeof vi.fn>,
  init: ConstructorParameters<typeof ApiError>[0],
) => mock.mockRejectedValueOnce(new ApiError(init));

describe('★★ a member’s login email', () => {
  it('★★ PATCH /admin-email with the member, the trimmed email and reason', async () => {
    api.patch.mockResolvedValue({ warnings: ['no_idp_identity'] });
    expect(await changeMemberEmail('t1', 'u1', ' new@acme.co ', ' typo ')).toEqual({
      ok: true,
      warnings: ['no_idp_identity'],
    });
    const call = api.patch.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/tenants/t1/admin-email');
    expect(call.body).toEqual({ userId: 'u1', newEmail: 'new@acme.co', reason: 'typo' });
  });

  it.each([
    [404, 'USER_NOT_FOUND', 'member_not_found'],
    [400, 'SYSTEM_ADMIN', 'system_admin'],
    [400, 'SAME_EMAIL', 'same_email'],
    [409, 'EMAIL_TAKEN', 'email_taken'],
    [409, 'IDENTITY_SHARED', 'identity_shared'],
    [502, 'IDP_SYNC_FAILED', 'idp_failed'],
    [502, 'IDP_STATE_UNKNOWN', 'idp_unknown'],
    [404, 'TENANT_NOT_FOUND', 'not_found'],
  ])('★ %i %s reads as %s', async (status, code, reason) => {
    refuseWith(api.patch, { kind: 'server', status, code });
    expect(await changeMemberEmail('t1', 'u1', 'a@b.co', 'r')).toEqual({ ok: false, reason });
  });
});

describe('★★ adding a member', () => {
  it('★★ POST /users with the member and the reason; the setup link is never read', async () => {
    api.post.mockResolvedValue({ data: { id: 'u9' }, setupLink: 'https://secret' });
    expect(
      await addMember(
        't1',
        { email: ' dana@acme.co ', name: ' Dana ', role: 'ADMIN' },
        ' new owner ',
      ),
    ).toEqual({ ok: true, warnings: [] });
    const call = api.post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/tenants/t1/users');
    expect(call.body).toEqual({
      email: 'dana@acme.co',
      name: 'Dana',
      role: 'ADMIN',
      reason: 'new owner',
    });
    expect(call.raw).toBe(true);
  });

  it.each([
    ['USER_EXISTS', 'already_member'],
    ['EMAIL_TAKEN', 'email_taken'],
  ])('★ 409 %s reads as %s', async (code, reason) => {
    refuseWith(api.post, { kind: 'conflict', status: 409, code });
    expect(await addMember('t1', { email: 'a@b.co', name: 'A', role: 'AGENT' }, 'r')).toEqual({
      ok: false,
      reason,
    });
  });

  it('★ a bare 500 is failed, never done', async () => {
    refuseWith(api.post, {
      kind: 'server',
      status: 500,
      developerMessage: 'Failed to create user',
    });
    expect(await addMember('t1', { email: 'a@b.co', name: 'A', role: 'AGENT' }, 'r')).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});

describe('★★ removing a member', () => {
  it('★★ DELETE /users/:id with the reason in the body', async () => {
    api.delete.mockResolvedValue({ deleted: true });
    expect(await removeMember('t1', 'u1', ' left the company ')).toEqual({
      ok: true,
      warnings: [],
    });
    const call = api.delete.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/tenants/t1/users/u1');
    expect(call.body).toEqual({ reason: 'left the company' });
  });

  it.each([
    [{ status: 409, code: 'LAST_ADMIN' }, 'last_admin'],
    [{ status: 404, developerMessage: 'User not found' }, 'member_not_found'],
    [{ status: 400, developerMessage: 'Cannot delete a system admin user' }, 'system_admin'],
    [{ status: 400, developerMessage: 'You cannot delete your own account' }, 'self'],
    [{ status: 400, developerMessage: 'Something new' }, 'failed'],
  ])('★ %o reads as %s (codes first, the older prose matched exactly)', async (init, reason) => {
    refuseWith(api.delete, { kind: 'validation', ...init });
    expect(await removeMember('t1', 'u1', 'r')).toEqual({ ok: false, reason });
  });

  it('★ a code wins over prose: prose is read only when the route sent no code', async () => {
    refuseWith(api.delete, {
      kind: 'conflict',
      status: 409,
      code: 'SOMETHING_ELSE',
      developerMessage: 'User not found',
    });
    expect(await removeMember('t1', 'u1', 'r')).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('★★ deleting a tenant', () => {
  it('★★ DELETE the tenant with the TYPED slug and the trimmed reason; leftovers come back', async () => {
    api.delete.mockResolvedValue({
      counts: { users: 2, conversations: 14, messages: 120, channelAccounts: 1, contacts: 9 },
      identitiesDeleted: 2,
      uploadFiles: 3,
      providerLeftovers: ['WHATSAPP:Acme WA (pn): number stays registered'],
      uploadsRemoved: false,
      uploadsLeftBehind: ['5f0c.png'],
    });
    expect(await deleteTenant('t1', 'acme', ' closed the account ')).toEqual({
      ok: true,
      deleted: {
        counts: { users: 2, conversations: 14, messages: 120, channelAccounts: 1, contacts: 9 },
        identitiesDeleted: 2,
        uploadFiles: 3,
        providerLeftovers: ['WHATSAPP:Acme WA (pn): number stays registered'],
        uploadsRemoved: false,
        uploadsLeftBehind: ['5f0c.png'],
      },
    });
    const call = api.delete.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/tenants/t1');
    expect(call.body).toEqual({ confirmSlug: 'acme', reason: 'closed the account' });
  });

  it("★★ the route's whole answer (eraseTenant) reads as the counts and what is left", async () => {
    const { deletedTenantSchema } = await import('@/api/contracts/console');
    expect(
      deletedTenantSchema.parse({
        deleted: true,
        tenantId: 't1',
        slug: 'acme',
        name: 'Acme',
        counts: { users: 2, conversations: 14, messages: 120, channelAccounts: 1, contacts: 9 },
        identitiesDeleted: 2,
        vectorsPurged: true,
        userCount: 2,
        providerLeftovers: ['WHATSAPP:Acme WA (pn): number stays registered'],
        uploadsRemoved: false,
        uploadFiles: 3,
        uploadsLeftBehind: ['5f0c.png'],
        tenantName: 'Acme',
      }),
    ).toEqual({
      counts: { users: 2, conversations: 14, messages: 120, channelAccounts: 1, contacts: 9 },
      identitiesDeleted: 2,
      uploadFiles: 3,
      providerLeftovers: ['WHATSAPP:Acme WA (pn): number stays registered'],
      uploadsRemoved: false,
      uploadsLeftBehind: ['5f0c.png'],
    });
  });

  it('★ a done delete is never "failed" because of its answer', async () => {
    const { deletedTenantSchema } = await import('@/api/contracts/console');
    const nothing = {
      counts: {
        users: null,
        conversations: null,
        messages: null,
        channelAccounts: null,
        contacts: null,
      },
      identitiesDeleted: null,
      uploadFiles: null,
      providerLeftovers: [],
      uploadsRemoved: true,
      uploadsLeftBehind: [],
    };
    expect(deletedTenantSchema.parse({ deleted: true })).toEqual(nothing);
    expect(deletedTenantSchema.parse('nonsense')).toEqual(nothing);
    // One unreadable count is said as nothing; the others still are.
    expect(
      deletedTenantSchema.parse({ counts: { users: 'two', conversations: 3 }, uploadFiles: -1 }),
    ).toEqual({
      ...nothing,
      counts: { ...nothing.counts, conversations: 3 },
    });
  });

  it.each([
    [404, 'TENANT_NOT_FOUND', 'not_found'],
    [400, 'CONFIRM_SLUG_MISMATCH', 'slug_mismatch'],
    [409, 'SYSTEM_TENANT', 'system_tenant'],
    [409, 'OWN_TENANT', 'own_tenant'],
    [409, 'ACTIVE_PAID_SUBSCRIPTION', 'paid_subscription'],
    [409, 'OPEN_CHECKOUT', 'open_checkout'],
    [409, 'SHOPIFY_BILLED', 'shopify_billed'],
  ])('★ %i %s reads as %s', async (status, code, reason) => {
    refuseWith(api.delete, { kind: 'conflict', status, code });
    expect(await deleteTenant('t1', 'acme', 'r')).toEqual({ ok: false, reason });
  });

  it('a validator 400 on the reason reads as reason_invalid', async () => {
    refuseWith(api.delete, {
      kind: 'validation',
      status: 400,
      fieldErrors: [{ field: 'reason', message: 'Required' }],
    });
    expect(await deleteTenant('t1', 'acme', '')).toEqual({ ok: false, reason: 'reason_invalid' });
  });
});

describe('★★ a manual billing edit', () => {
  it('★★ POST /billing/manual with the edit and the trimmed reason; renewal and end come back', async () => {
    // The transport parses with the payload schema; the mock answers parsed.
    api.post.mockResolvedValue({
      renewal: 'off',
      after: { currentPeriodEnd: '2099-03-31T00:00:00.000Z' },
      warnings: ['open_checkout'],
    });
    expect(
      await manualBillingEdit('t1', { action: 'add_credits', units: 5 }, ' goodwill '),
    ).toEqual({
      ok: true,
      renewal: 'off',
      after: { currentPeriodEnd: '2099-03-31T00:00:00.000Z' },
      warnings: ['open_checkout'],
    });
    const call = api.post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/tenants/t1/billing/manual');
    expect(call.body).toEqual({ action: 'add_credits', units: 5, reason: 'goodwill' });
    const { manualBillingSchema } = await import('@/api/contracts/console');
    expect(call.payload).toBe(manualBillingSchema);
    expect(
      manualBillingSchema.parse({
        renewal: 'off',
        after: { currentPeriodEnd: '2099-03-31T00:00:00.000Z', planKey: 'x' },
        charges: 'none',
      }),
    ).toEqual({
      renewal: 'off',
      after: { currentPeriodEnd: '2099-03-31T00:00:00.000Z' },
      warnings: [],
    });
  });

  it('★ an answer it cannot read is still done, with the renewal unsaid', async () => {
    const { manualBillingSchema } = await import('@/api/contracts/console');
    expect(manualBillingSchema.parse({ renewal: 'maybe' })).toEqual({
      renewal: null,
      after: null,
      warnings: [],
    });
  });

  it.each([
    ['SHOPIFY_BILLED', 'shopify_billed'],
    ['IN_DUNNING', 'in_dunning'],
    ['GRANDFATHERED', 'grandfathered'],
    ['SUBSCRIPTION_STATE_NOT_EDITABLE', 'state_not_editable'],
    ['END_DATE_REQUIRED', 'end_date_required'],
    ['END_DATE_IN_PAST', 'end_date_in_past'],
    ['EXPIRY_MUST_BE_IN_THE_FUTURE', 'end_date_in_past'],
    ['NO_SUBSCRIPTION', 'no_subscription'],
    ['PLAN_VERSION_NOT_ACTIVE', 'plan_unavailable'],
    ['PLAN_VERSION_BELONGS_TO_ANOTHER_ORGANIZATION', 'plan_unavailable'],
    ['VOLUME_OPTION_INVALID', 'volume_invalid'],
    ['UNKNOWN_FEATURE_DOMAIN', 'unknown_domain'],
    ['TENANT_NOT_FOUND', 'not_found'],
  ])('★ 409 %s reads as %s', async (code, reason) => {
    refuseWith(api.post, {
      kind: 'conflict',
      status: 409,
      code,
      developerMessage: 'Refused by billing',
    });
    expect(await manualBillingEdit('t1', { action: 'add_credits', units: 5 }, 'r')).toEqual({
      ok: false,
      reason,
    });
  });

  it('★ 502 BILLING_UNREACHABLE: nothing was changed, said so', async () => {
    refuseWith(api.post, { kind: 'server', status: 502, code: 'BILLING_UNREACHABLE' });
    expect(await manualBillingEdit('t1', { action: 'add_credits', units: 5 }, 'r')).toEqual({
      ok: false,
      reason: 'billing_unreachable',
    });
  });

  it('a code billing has not told us about is failed, logged', async () => {
    refuseWith(api.post, { kind: 'server', status: 502, code: 'manual_edit_failed' });
    expect(await manualBillingEdit('t1', { action: 'add_credits', units: 5 }, 'r')).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(warn).toHaveBeenCalledWith('console.manual_billing_failed', expect.anything());
  });
});
