import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * ★★ The grant ceiling at every save (auth 679b8812): role create and edit,
 * a grant added or removed, a role changed. Each 403 is read by its CODE -
 * before the bare 403 each of these already said as "forbidden".
 */
const api = vi.hoisted(() => ({ put: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { addPermission, changeRole, createRole, removePermission, updateRole } from './actions';

const ABOVE = () =>
  new ApiError({
    kind: 'authorization',
    status: 403,
    code: 'ABOVE_OWN_ROLE',
    missing: ['billing:invoices:read'],
  });
const OWNER = () => new ApiError({ kind: 'authorization', status: 403, code: 'OWNER_ONLY' });
const above = { ok: false, reason: 'above_own_role', missing: ['billing:invoices:read'] };
const owner = { ok: false, reason: 'owner_only' };

beforeEach(() => {
  api.put.mockReset();
  api.post.mockReset();
  api.patch.mockReset();
});

const saves: [string, () => Promise<unknown>, 'put' | 'post'][] = [
  ['createRole', () => createRole({ name: 'Desk', description: '', features: ['*'] }), 'post'],
  [
    'updateRole',
    () => updateRole('r1', { name: 'Desk', description: '', features: ['*'], isSystem: false }),
    'put',
  ],
  ['addPermission', () => addPermission('u1', 'billing:invoices:read', 'why'), 'put'],
  ['removePermission', () => removePermission('u1', 'billing:invoices:read', 'why'), 'put'],
  ['changeRole', () => changeRole('u1', 'owner-role', null), 'put'],
];

describe.each(saves)('★★ %s', (_name, save, method) => {
  it('ABOVE_OWN_ROLE: its own reason, with the keys the caller lacks', async () => {
    api[method].mockRejectedValueOnce(ABOVE());
    expect(await save()).toEqual(above);
  });

  it('OWNER_ONLY: its own reason', async () => {
    api[method].mockRejectedValueOnce(OWNER());
    expect(await save()).toEqual(owner);
  });

  it('a bare 403 is still "forbidden"', async () => {
    api[method].mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await save()).toMatchObject({ ok: false, reason: 'forbidden' });
  });
});

it('★ updateRole: refused at the capabilities, nothing renamed', async () => {
  api.put.mockRejectedValueOnce(ABOVE());
  await updateRole('r1', { name: 'Desk', description: '', features: ['*'], isSystem: false });
  expect(api.patch).not.toHaveBeenCalled();
});
