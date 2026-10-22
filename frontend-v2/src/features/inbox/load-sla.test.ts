import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * W2's reads. The platform is mocked: what is asked, and what a refusal or a
 * failure becomes.
 */
const { get, warn } = vi.hoisted(() => ({ get: vi.fn(), warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

const { loadSlaClock, loadSlaSettings } = await import('./load-sla');

beforeEach(() => {
  get.mockReset();
  warn.mockReset();
});

const forbidden = () => new ApiError({ status: 403, kind: 'authorization' });

describe('★★ the workspace’s target', () => {
  it('read once, as sent', async () => {
    get.mockResolvedValueOnce({ enabled: true, slaMinutes: 30, warningThreshold: 70 });
    expect(await loadSlaSettings()).toEqual({
      enabled: true,
      slaMinutes: 30,
      warningThreshold: 70,
    });
    expect(get.mock.calls[0]![0].endpoint.path).toBe('/api/agents/settings/sla');
  });

  it('★★ a 403 (anyone but an Owner, today) is null, and not logged as a fault', async () => {
    get.mockRejectedValueOnce(forbidden());
    expect(await loadSlaSettings()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failure is null too, and logged', async () => {
    get.mockRejectedValueOnce(new Error('down'));
    expect(await loadSlaSettings()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('★★ the clock: the departments on this page, once each', () => {
  const on = { enabled: true, slaMinutes: 30, warningThreshold: 70 };

  it('★ no target, switched off, or no minutes: no clock and no further read', async () => {
    for (const settings of [null, { ...on, enabled: false }, { ...on, slaMinutes: null }]) {
      expect(await loadSlaClock(settings, ['d1'])).toBeNull();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('★★ each department once: its own minutes, the workspace’s, or unread', async () => {
    get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      if (endpoint.path.endsWith('/d1'))
        return { enabled: true, slaMinutes: 10, warningThreshold: null };
      if (endpoint.path.endsWith('/d2'))
        return { enabled: false, slaMinutes: null, warningThreshold: null };
      throw new Error('down');
    });
    const clock = await loadSlaClock(on, ['d1', 'd2', 'd1', 'd3']);
    expect(get).toHaveBeenCalledTimes(3);
    expect(clock).toEqual({
      minutes: 30,
      warningPercent: 70,
      departments: { d1: 10, d2: 'workspace', d3: 'unread' },
    });
  });
});
