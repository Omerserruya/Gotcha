import { beforeEach, describe, expect, it, vi } from 'vitest';

/** ★★ The console's door, on the server: SYSTEM_ADMIN, or "not found". */
const held = vi.hoisted(() => ({
  value: { roleKey: undefined as string | undefined, status: 'loaded' as string },
}));
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('next/navigation', () => ({ notFound }));
vi.mock('./load-permissions', () => ({
  loadPermissions: async () => ({ permissions: [], ...held.value }),
}));

const { requireConsole } = await import('./require-console');

const asRole = (roleKey: string | undefined, status = 'loaded') => {
  held.value = { roleKey, status };
  return requireConsole();
};

beforeEach(() => {
  notFound.mockClear();
});

describe('★★ requireConsole', () => {
  it('★ a system admin passes', async () => {
    await expect(asRole('system_admin')).resolves.toBeUndefined();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('★★ an owner or an admin of a tenant: not found', async () => {
    await expect(asRole('owner')).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(asRole('admin')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(2);
  });

  it('★★ an unread role is a closed door, not an open one', async () => {
    await expect(asRole(undefined, 'unavailable')).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
