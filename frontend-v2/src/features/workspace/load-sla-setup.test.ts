import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const { get, warn } = vi.hoisted(() => ({ get: vi.fn(), warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

const { loadDepartmentSlas, loadSlaSetup } = await import('./load-sla-setup');

beforeEach(() => {
  get.mockReset();
  warn.mockReset();
});

describe('★★ W2 - who may see the target, and who may change it', () => {
  const SETTINGS = { enabled: true, slaMinutes: 30, warningThreshold: 70 };
  /** The target's read, and `/me` with this role (`undefined`: unread). */
  const route = (sla: () => unknown, role: string | null | undefined) =>
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      if (endpoint.path === '/api/auth/me') {
        if (role === undefined) throw new Error('down');
        return { user: { id: 'u1', email: 'a@b.c', role }, tenantStatus: 'ACTIVE' };
      }
      return sla();
    });

  it('the admin role: the settings, to edit', async () => {
    route(() => SETTINGS, 'ADMIN');
    expect(await loadSlaSetup()).toEqual({ kind: 'owner', settings: SETTINGS });
  });

  it('★★ anyone else the read answers: the value, read only - their save would be refused', async () => {
    route(() => SETTINGS, 'AGENT');
    expect(await loadSlaSetup()).toEqual({ kind: 'readOnly', settings: SETTINGS });
  });

  it('★ a role unread is not admin', async () => {
    route(() => SETTINGS, undefined);
    expect(await loadSlaSetup()).toEqual({ kind: 'readOnly', settings: SETTINGS });
  });

  it('★★ a 403 is "not yours", not a fault', async () => {
    route(() => {
      throw new ApiError({ status: 403, kind: 'authorization' });
    }, 'AGENT');
    expect(await loadSlaSetup()).toEqual({ kind: 'forbidden' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('anything else is a failed read', async () => {
    route(() => {
      throw new Error('down');
    }, 'ADMIN');
    expect(await loadSlaSetup()).toEqual({ kind: 'failed' });
  });
});

describe('★★ the departments, each with its own target or null', () => {
  it('active ones only; a failed own read is null, never a default', async () => {
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      if (endpoint.path === '/api/departments') {
        return [
          { id: 'd1', name: 'Sales', isActive: true },
          { id: 'd2', name: 'Old', isActive: false },
          { id: 'd3', name: 'Returns', isActive: true },
        ];
      }
      if (endpoint.path.endsWith('/d1'))
        return { enabled: true, slaMinutes: 10, warningThreshold: null };
      throw new Error('down');
    });
    expect(await loadDepartmentSlas()).toEqual([
      { id: 'd1', name: 'Sales', own: { enabled: true, slaMinutes: 10, warningThreshold: null } },
      { id: 'd3', name: 'Returns', own: null },
    ]);
  });

  it('the departments unread: null', async () => {
    get.mockRejectedValueOnce(new Error('down'));
    expect(await loadDepartmentSlas()).toBeNull();
  });
});
