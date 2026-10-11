import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * ★★ G5 at the wire (auth 679b8812): `role` goes in the one POST, and every
 * refusal comes back as its own reason. Mocked - no request is made.
 */
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { inviteMember } from './actions';

const base = { email: ' Dana@AvivCo.il ', name: 'Dana', departmentIds: [] as string[] };
const refuse = (status: number, code: string, missing?: string[]) =>
  api.post.mockRejectedValueOnce(
    new ApiError({
      kind: status === 400 ? 'validation' : 'authorization',
      status,
      code,
      ...(missing ? { missing } : {}),
    }),
  );

beforeEach(() => {
  api.post.mockReset();
});

describe('★★ G5 - POST /api/agents takes the role', () => {
  it('sends the role id with the rest', async () => {
    api.post.mockResolvedValue({ user: { id: 'u9' } });
    await inviteMember({ ...base, role: 'r-desk' });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/agents' },
      body: { email: 'dana@avivco.il', name: 'Dana', role: 'r-desk' },
    });
  });

  it('no role: none sent - the route invites as an agent', async () => {
    api.post.mockResolvedValue({ user: { id: 'u9' } });
    await inviteMember({ ...base, role: null });
    await inviteMember(base);
    for (const call of api.post.mock.calls) {
      expect((call[0] as { body: object }).body).not.toHaveProperty('role');
    }
  });

  it('ABOVE_OWN_ROLE with its keys, OWNER_ONLY, UNKNOWN_ROLE - each its own reason', async () => {
    refuse(403, 'ABOVE_OWN_ROLE', ['billing:invoices:read']);
    expect(await inviteMember({ ...base, role: 'r-admin' })).toEqual({
      ok: false,
      reason: 'above_own_role',
      missing: ['billing:invoices:read'],
    });
    refuse(403, 'OWNER_ONLY');
    expect(await inviteMember({ ...base, role: 'r-owner' })).toEqual({
      ok: false,
      reason: 'owner_only',
    });
    refuse(400, 'UNKNOWN_ROLE');
    expect(await inviteMember({ ...base, role: 'gone' })).toEqual({
      ok: false,
      reason: 'unknown_role',
    });
    // A bare 403 stays what it was.
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await inviteMember(base)).toEqual({ ok: false, reason: 'forbidden' });
  });
});
