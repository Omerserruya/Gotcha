import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));

import {
  lastSevenDays,
  loadAnalytics,
  loadGotcha,
  loadSales,
  loadTeam,
  loadTopics,
} from './load-analytics';

beforeEach(() => {
  get.mockReset().mockResolvedValue([]);
});

describe('★★ the screen says "last 7 days" - and that is what it asks for', () => {
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
    // `{ period, data }` - unwrapping would hand the array to an object schema.
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
  it('★ the team report for seven days, beside who holds what now', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string } }) =>
      r.endpoint.path === '/api/analytics/team' ? { members: [], cards: {} } : [],
    );
    const data = await loadTeam();
    const call = get.mock.calls.find((c) => c[0].endpoint.path === '/api/analytics/team');
    expect(call?.[0].query).toEqual({ days: 7 });
    expect(data.report).toEqual({ members: [], cards: {} });
    expect(data.agents).toEqual([]);
  });

  it('⚠ a failed report is null - the table says it, not "no one on the team"', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string } }) => {
      if (r.endpoint.path === '/api/analytics/team') throw new Error('down');
      return [];
    });
    expect((await loadTeam()).report).toBeNull();
  });
});

describe('★ 06d’s read', () => {
  it('product demand is read raw - `{ weekKey, data }` - and a failure is null', async () => {
    get.mockResolvedValue({ weekKey: '2026-W40', data: [] });
    await loadSales();
    const req = get.mock.calls[0]![0] as { endpoint: { path: string }; raw?: boolean };
    expect(req.endpoint.path).toBe('/api/analytics/product-demand');
    expect(req.raw).toBe(true);
    get.mockRejectedValue(new Error('down'));
    expect((await loadSales()).demand).toBeNull();
  });
});

describe('★ 06e’s reads', () => {
  it('topics for this week AND the week before - that is what makes "Change" real', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string } }) =>
      r.endpoint.path.endsWith('unanswered-questions') ? { data: [] } : [],
    );
    await loadTopics(new Date('2026-10-02T12:00:00.000Z'));
    const windows = get.mock.calls
      .map((c) => c[0] as { endpoint: { path: string }; query: { from: string; to: string } })
      .filter((r) => r.endpoint.path === '/api/analytics/top-questions')
      .map((r) => [r.query.from, r.query.to]);
    expect(windows).toEqual([
      ['2026-09-25T12:00:00.000Z', '2026-10-02T12:00:00.000Z'],
      ['2026-09-18T12:00:00.000Z', '2026-09-25T12:00:00.000Z'],
    ]);
  });

  it('★ the topics are asked for in the reader’s language - their names come back in it', async () => {
    get.mockImplementation(async (r: { endpoint: { path: string } }) =>
      r.endpoint.path.endsWith('unanswered-questions') ? { data: [] } : [],
    );
    await loadTopics(new Date('2026-10-02T12:00:00.000Z'));
    await loadAnalytics();
    const asked = get.mock.calls
      .map((c) => c[0] as { endpoint: { path: string }; query?: { locale?: string } })
      .filter((r) => r.endpoint.path === '/api/analytics/top-questions');
    expect(asked).toHaveLength(3);
    expect(asked.every((r) => r.query?.locale === 'he')).toBe(true);
  });
});
