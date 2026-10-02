import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

import {
  lastSevenDays,
  lastSevenUtcDates,
  loadAnalytics,
  loadGotcha,
  loadSales,
  loadTeam,
} from './load-analytics';

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

describe('★ 06b’s reads', () => {
  const asked = (path: string) =>
    get.mock.calls
      .map((c) => c[0])
      .find((r: { endpoint: { path: string } }) => r.endpoint.path === path) as {
      query?: Record<string, unknown>;
      raw?: boolean;
    };

  it('every read is the last seven days; unanswered questions raw, at the route’s page', async () => {
    await loadGotcha();
    for (const path of [
      '/api/analytics/overview',
      '/api/analytics/time-saved',
      '/api/analytics/tool-usage',
      '/api/analytics/ai-performance',
      '/api/analytics/unanswered-questions',
    ]) {
      const { from, to } = asked(path).query as { from: string; to: string };
      expect(Date.parse(to) - Date.parse(from), path).toBe(7 * 24 * 60 * 60 * 1000);
    }
    const unanswered = asked('/api/analytics/unanswered-questions');
    // `{ period, data }` — unwrapping would hand the array to an object schema.
    expect(unanswered.raw).toBe(true);
    expect(unanswered.query?.limit).toBe(50);
  });

  it('a failed read is null for that part only', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string } }) => {
      if (r.endpoint.path === '/api/analytics/tool-usage') throw new Error('403');
      if (r.endpoint.path === '/api/analytics/unanswered-questions') return { data: [] };
      if (
        r.endpoint.path === '/api/analytics/ai-performance' ||
        r.endpoint.path.endsWith('overview') ||
        r.endpoint.path.endsWith('time-saved')
      )
        return {};
      return [];
    });
    const data = await loadGotcha();
    expect(data.tools).toBeNull();
    expect(data.unanswered).toEqual({ data: [] });
    expect(data.ai).not.toBeNull();
  });
});

describe('★ 06c’s reads', () => {
  it('seven UTC dates, oldest first, as /hourly keys them', () => {
    expect(lastSevenUtcDates(new Date('2026-10-02T01:00:00.000Z'))).toEqual([
      '2026-09-26',
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('★ /hourly once per day; a day that failed is dropped, the rest kept', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string }; query?: { date?: string } }) => {
      if (r.endpoint.path === '/api/analytics/hourly') {
        if (r.query?.date === lastSevenUtcDates()[0]) throw new Error('down');
        return [{ hour: '09:00', inbound: 1, outbound: 0 }];
      }
      if (r.endpoint.path === '/api/analytics/overview') return {};
      return [];
    });
    const data = await loadTeam();
    const hourlyCalls = get.mock.calls.filter(
      (c) => c[0].endpoint.path === '/api/analytics/hourly',
    );
    expect(hourlyCalls).toHaveLength(7);
    expect(data.hourly).toHaveLength(6);
  });

  it('⚠ every day failing is null, not an empty week', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string } }) => {
      if (r.endpoint.path === '/api/analytics/hourly') throw new Error('down');
      if (r.endpoint.path === '/api/analytics/overview') return {};
      return [];
    });
    expect((await loadTeam()).hourly).toBeNull();
  });
});

describe('★ 06d’s read', () => {
  it('product demand is read raw — `{ weekKey, data }` — and a failure is null', async () => {
    get.mockResolvedValue({ weekKey: '2026-W40', data: [] });
    await loadSales();
    const req = get.mock.calls[0]![0] as { endpoint: { path: string }; raw?: boolean };
    expect(req.endpoint.path).toBe('/api/analytics/product-demand');
    expect(req.raw).toBe(true);
    get.mockRejectedValue(new Error('down'));
    expect((await loadSales()).demand).toBeNull();
  });
});
