import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';

const { loadReadinessStatus } = vi.hoisted(() => ({ loadReadinessStatus: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./load-readiness-status', () => ({ loadReadinessStatus }));

const { loadReadinessRun } = await import('./load-readiness-run');

describe('★ 07e - the hired employee’s readiness run, by its stored status', () => {
  it('reads THIS employee’s status and judges it by the page’s own rule', async () => {
    loadReadinessStatus.mockResolvedValueOnce({ readinessStatus: 'running' });
    const employee = employeeSchema.parse({ id: 'h1', name: 'New', status: 'ACTIVE' });
    expect(await loadReadinessRun(employee)).toEqual({ state: 'running' });
    expect(loadReadinessStatus).toHaveBeenCalledWith('h1');
    loadReadinessStatus.mockResolvedValueOnce({
      readinessStatus: 'failed',
      readinessError: 'timed_out',
    });
    expect(await loadReadinessRun(employee)).toEqual({ state: 'failed', failure: 'timed_out' });
  });
});
