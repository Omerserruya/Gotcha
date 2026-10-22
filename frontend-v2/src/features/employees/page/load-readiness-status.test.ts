import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readinessRunStatusSchema } from '@/api/contracts/employees';

const { get, warn } = vi.hoisted(() => ({ get: vi.fn(), warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

const { loadReadinessStatus } = await import('./load-readiness-status');

beforeEach(() => {
  get.mockReset();
  warn.mockReset();
});

describe('★ H7 - the run status is the employee’s own read', () => {
  it('GET /api/ai-agents/:id, read by the status contract', async () => {
    get.mockResolvedValue({ readinessStatus: 'running' });
    expect(await loadReadinessStatus('e1')).toEqual({ readinessStatus: 'running' });
    expect(get.mock.calls[0]![0].endpoint.path).toBe('/api/ai-agents/e1');
    expect(get.mock.calls[0]![0].payload).toBe(readinessRunStatusSchema);
  });

  it('a failed read is null - the page falls back, never says "not running"', async () => {
    get.mockRejectedValue(new Error('down'));
    expect(await loadReadinessStatus('e1')).toBeNull();
    expect(warn).toHaveBeenCalledWith('employees.readiness_status_failed', expect.anything());
  });
});
