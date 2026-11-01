import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* The tenant delete at the wire. ⚠ Mocked: nothing is sent. */
const { api, signIn, warn } = vi.hoisted(() => ({
  api: { delete: vi.fn() },
  signIn: vi.fn(async () => {}),
  warn: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: signIn }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { deleteTenant } from './edit-actions';

beforeEach(() => {
  for (const each of Object.values(api)) each.mockReset();
  signIn.mockClear();
  warn.mockClear();
});

const refuseWith = (
  mock: ReturnType<typeof vi.fn>,
  init: ConstructorParameters<typeof ApiError>[0],
) => mock.mockRejectedValueOnce(new ApiError(init));

describe('★★ a refusal, read by code', () => {
  it('★★ TENANT_NOT_FOUND is "no such tenant" - read by code, whatever kind the transport filed', async () => {
    // The transport files any TENANT_* code as tenant_inactive.
    api.delete.mockRejectedValue(
      new ApiError({ kind: 'tenant_inactive', status: 404, code: 'TENANT_NOT_FOUND' }),
    );
    expect(await deleteTenant('t1', 'acme', 'r')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a validator 400 on another field reads as invalid', async () => {
    refuseWith(api.delete, {
      kind: 'validation',
      status: 400,
      fieldErrors: [{ field: 'confirmSlug', message: 'Required' }],
    });
    expect(await deleteTenant('t1', '', 'r')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('403 is forbidden; anything else is failed, logged, never "nothing happened"', async () => {
    refuseWith(api.delete, { kind: 'authorization', status: 403 });
    expect(await deleteTenant('t1', 'acme', 'r')).toEqual({ ok: false, reason: 'forbidden' });
    refuseWith(api.delete, { kind: 'server', status: 500 });
    expect(await deleteTenant('t1', 'acme', 'r')).toEqual({ ok: false, reason: 'failed' });
    expect(warn).toHaveBeenCalledWith('console.tenant_delete_failed', expect.anything());
  });

  it('a signed-out caller is sent to sign in', async () => {
    const cause = new ApiError({ kind: 'authentication', status: 401 });
    api.delete.mockRejectedValue(cause);
    await deleteTenant('t1', 'acme', 'r');
    expect(signIn).toHaveBeenCalledWith(cause);
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
