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

describe('★★ W2 - who may see the target', () => {
  it('an Owner: the settings', async () => {
    get.mockResolvedValueOnce({ enabled: true, slaMinutes: 30, warningThreshold: 70 });
    expect(await loadSlaSetup()).toEqual({
      kind: 'owner',
      settings: { enabled: true, slaMinutes: 30, warningThreshold: 70 },
    });
  });

  it('★★ a 403 is "not yours", not a fault', async () => {
    get.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await loadSlaSetup()).toEqual({ kind: 'forbidden' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('anything else is a failed read', async () => {
    get.mockRejectedValueOnce(new Error('down'));
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
