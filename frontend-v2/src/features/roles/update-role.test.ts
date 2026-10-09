import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const api = vi.hoisted(() => ({ put: vi.fn(), patch: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { updateRole } from './actions';

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

  it('★ a built-in role is never sent (both routes refuse it; the screen does not ask)', async () => {
    expect(await updateRole('admin', { ...INPUT, isSystem: true })).toEqual({
      ok: false,
      reason: 'system',
    });
    expect(api.put).not.toHaveBeenCalled();
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
  it('403 SYSTEM_ROLE on the capabilities: a built-in role, said as one - nothing renamed', async () => {
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
