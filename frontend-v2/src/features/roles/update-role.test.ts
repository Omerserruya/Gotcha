import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const api = vi.hoisted(() => ({ put: vi.fn(), patch: vi.fn(), post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { resetRole, updateRole } from './actions';

const INPUT = {
  name: 'Finance',
  description: 'Refunds',
  features: ['crm:contacts:read'],
  isSystem: false,
};
const path = (call: unknown[]) => (call[0] as { endpoint: { path: string } }).endpoint.path;

beforeEach(() => {
  api.put.mockReset();
  api.patch.mockReset();
  api.post.mockReset();
});

describe('★★ 12b Edit at the wire: capabilities first, then the name', () => {
  it('PUT …/roles/:id/features, then PATCH …/roles/:id', async () => {
    api.put.mockResolvedValue({});
    api.patch.mockResolvedValue({});
    expect(await updateRole('r7', INPUT)).toEqual({ ok: true });
    expect(path(api.put.mock.calls[0]!)).toBe('/api/permissions/roles/r7/features');
    expect(api.put.mock.calls[0]![0]).toMatchObject({ body: { features: ['crm:contacts:read'] } });
    expect(path(api.patch.mock.calls[0]!)).toBe('/api/permissions/roles/r7');
    expect(api.patch.mock.calls[0]![0]).toMatchObject({
      body: { name: 'Finance', description: 'Refunds' },
    });
    expect(api.put.mock.invocationCallOrder[0]!).toBeLessThan(
      api.patch.mock.invocationCallOrder[0]!,
    );
  });

  it('★ a built-in role (auth 30d610da): its capabilities only - it is never renamed', async () => {
    api.put.mockResolvedValue({});
    expect(
      await updateRole('owner', { ...INPUT, features: ['*', 'crm:contacts:read'], isSystem: true }),
    ).toEqual({ ok: true });
    expect(path(api.put.mock.calls[0]!)).toBe('/api/permissions/roles/owner/features');
    expect(api.put.mock.calls[0]![0]).toMatchObject({
      body: { features: ['*', 'crm:contacts:read'] },
    });
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('a capability refused (400) changes nothing; after the capabilities, a failure is "partial"', async () => {
    api.put.mockRejectedValueOnce(new ApiError({ kind: 'validation', status: 400 }));
    expect(await updateRole('r7', INPUT)).toEqual({ ok: false, reason: 'unknown_features' });
    expect(api.patch).not.toHaveBeenCalled();
    api.put.mockResolvedValueOnce({});
    api.patch.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await updateRole('r7', INPUT)).toEqual({ ok: false, reason: 'partial' });
  });
});

describe('★★ 12b Edit - the server’s refusals, by their codes (auth 00d669a3)', () => {
  it('403 SYSTEM_ROLE on the capabilities (the kill switch): said as one - nothing renamed', async () => {
    api.put.mockRejectedValueOnce(
      new ApiError({ kind: 'authorization', status: 403, code: 'SYSTEM_ROLE' }),
    );
    expect(await updateRole('r7', INPUT)).toEqual({ ok: false, reason: 'system' });
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('409 ROLE_NAME_TAKEN on the rename: name_taken, not "partial"', async () => {
    api.put.mockResolvedValueOnce({});
    api.patch.mockRejectedValueOnce(
      new ApiError({ kind: 'conflict', status: 409, code: 'ROLE_NAME_TAKEN' }),
    );
    expect(await updateRole('r7', INPUT)).toEqual({ ok: false, reason: 'name_taken' });
  });
});

const refuse = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({
    kind: status === 409 ? 'conflict' : status === 422 ? 'validation' : 'authorization',
    status,
    code,
    ...extra,
  });

describe('★★ a built-in role’s own refusals, each its own reason (auth 30d610da)', () => {
  const BUILTIN = { ...INPUT, isSystem: true };

  it('403 ROLE_CEILING keeps the blocked keys - never the bare "forbidden"', async () => {
    api.put.mockRejectedValueOnce(
      refuse(403, 'ROLE_CEILING', { blocked: ['settings:roles:manage'] }),
    );
    expect(await updateRole('agent', BUILTIN)).toEqual({
      ok: false,
      reason: 'role_ceiling',
      blocked: ['settings:roles:manage'],
    });
  });

  it('422 OWNER_FLOOR keeps the missing keys', async () => {
    api.put.mockRejectedValueOnce(
      refuse(422, 'OWNER_FLOOR', { missing: ['settings:billing:manage'] }),
    );
    expect(await updateRole('owner', BUILTIN)).toEqual({
      ok: false,
      reason: 'owner_floor',
      missing: ['settings:billing:manage'],
    });
  });

  it('409 ROLE_MERGED', async () => {
    api.put.mockRejectedValueOnce(refuse(409, 'ROLE_MERGED'));
    expect(await updateRole('admin', BUILTIN)).toEqual({ ok: false, reason: 'role_merged' });
  });

  it('the grant ceiling still answers as before', async () => {
    api.put.mockRejectedValueOnce(
      refuse(403, 'ABOVE_OWN_ROLE', { missing: ['settings:billing:manage'] }),
    );
    expect(await updateRole('dm', BUILTIN)).toEqual({
      ok: false,
      reason: 'above_own_role',
      missing: ['settings:billing:manage'],
    });
  });

  it('nothing is renamed on any of them', async () => {
    api.put.mockRejectedValueOnce(refuse(403, 'ROLE_CEILING', { blocked: [] }));
    await updateRole('r7', INPUT);
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('★★ Reset to default - POST …/roles/:id/reset (auth 30d610da)', () => {
  it('posts to the role’s reset, and nothing else', async () => {
    api.post.mockResolvedValue({});
    expect(await resetRole('dm')).toEqual({ ok: true });
    expect(path(api.post.mock.calls[0]!)).toBe('/api/permissions/roles/dm/reset');
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('409 NOT_BUILTIN: only a built-in role has defaults', async () => {
    api.post.mockRejectedValueOnce(refuse(409, 'NOT_BUILTIN'));
    expect(await resetRole('custom')).toEqual({ ok: false, reason: 'not_builtin' });
  });

  it('the grant ceiling on the defaults, and a role that is gone', async () => {
    api.post.mockRejectedValueOnce(refuse(403, 'OWNER_ONLY'));
    expect(await resetRole('owner')).toEqual({ ok: false, reason: 'owner_only' });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await resetRole('gone')).toEqual({ ok: false, reason: 'gone' });
  });
});
