import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const api = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { changeRole } from './actions';

const path = (call: unknown[]) => (call[0] as { endpoint: { path: string } }).endpoint.path;
const refuse = (status: number, code?: string) =>
  api.put.mockRejectedValueOnce(
    new ApiError({ kind: status === 409 ? 'conflict' : 'authorization', status, code }),
  );

beforeEach(() => {
  api.put.mockReset();
});

describe('★★ 12d Change at the wire - PUT, replacing (auth 00d669a3)', () => {
  it('PUT …/users/:id/role with the role, and the scope they hold kept', async () => {
    api.put.mockResolvedValue({});
    expect(await changeRole('u1', 'agent', 'team')).toEqual({ ok: true });
    expect(path(api.put.mock.calls[0]!)).toBe('/api/permissions/users/u1/role');
    expect(api.put.mock.calls[0]![0]).toMatchObject({ body: { roleId: 'agent', scope: 'TEAM' } });
  });

  it('a scope the route does not know is sent as none - never one it refuses', async () => {
    api.put.mockResolvedValue({});
    await changeRole('u1', 'agent', 'region');
    await changeRole('u1', 'agent', null);
    expect(api.put.mock.calls.map((c) => (c[0] as { body: unknown }).body)).toEqual([
      { roleId: 'agent', scope: null },
      { roleId: 'agent', scope: null },
    ]);
  });

  it('the two lock-outs by their codes; 404 gone; 403 forbidden; else failed', async () => {
    refuse(409, 'SELF_LOCKOUT');
    expect(await changeRole('u1', 'agent', null)).toEqual({ ok: false, reason: 'self_lockout' });
    refuse(409, 'LAST_ADMIN');
    expect(await changeRole('u1', 'agent', null)).toEqual({ ok: false, reason: 'last_admin' });
    refuse(404);
    expect(await changeRole('u1', 'agent', null)).toEqual({ ok: false, reason: 'gone' });
    refuse(403);
    expect(await changeRole('u1', 'agent', null)).toEqual({ ok: false, reason: 'forbidden' });
    refuse(409);
    expect(await changeRole('u1', 'agent', null)).toEqual({ ok: false, reason: 'failed' });
  });
});
