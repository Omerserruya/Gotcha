import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

import { lastSevenDays, loadAnalytics } from './load-analytics';

beforeEach(() => {
  get.mockReset().mockResolvedValue([]);
});

describe('★★ the screen says "last 7 days" — and that is what it asks for', () => {
  it('overview and time saved are read for the last seven days', async () => {
    await loadAnalytics();
    const asked = (path: string) =>
      get.mock.calls
        .map((c) => c[0])
        .find((r: { endpoint: { path: string } }) => r.endpoint.path === path);
    for (const path of ['/api/analytics/overview', '/api/analytics/time-saved']) {
      const { from, to } = asked(path).query as { from: string; to: string };
      expect(Date.parse(to) - Date.parse(from), path).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });

  it('★ a failed read is null for that part only', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string } }) => {
      if (r.endpoint.path === '/api/analytics/overview') throw new Error('down');
      return [];
    });
    const data = await loadAnalytics();
    expect(data.overview).toBeNull();
    expect(data.insights).toEqual([]);
  });

  it('lastSevenDays is seven days to now', () => {
    const now = new Date('2026-10-02T12:00:00.000Z');
    expect(lastSevenDays(now)).toEqual({
      from: '2026-09-25T12:00:00.000Z',
      to: '2026-10-02T12:00:00.000Z',
    });
  });
});
