import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn(async (_request: unknown): Promise<unknown> => ({})));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { aiFailuresSchema } from '@/api/contracts/ai-failures';

import { loadAiAlertCount, loadAiFailures, loadTenantNames } from './load-ai-failures';

/**
 * ★★ The console's reads of the AI's failed actions: the filters as the
 * route takes them, an unread answer as `null` (never "nothing failed"),
 * and one odd row dropped rather than the page.
 */
type Call = { endpoint: { path: string }; query?: Record<string, unknown>; raw?: boolean };
const call = () => get.mock.calls[0]![0] as Call;

beforeEach(() => {
  get.mockReset();
});

describe('★★ loadAiFailures', () => {
  it('asks with the hours always, and a tenant and a tool only when chosen', async () => {
    get.mockResolvedValueOnce({ hours: 6, total: 0, groups: [], recent: [] });
    await loadAiFailures({ hours: 6, tenantId: '', tool: '' });
    expect(call().endpoint.path).toBe('/api/system/ai-actions/failures');
    expect(call().query).toEqual({ hours: 6, tenantId: undefined, tool: undefined });
    expect(call().raw).toBe(true);
  });

  it('★ an unread answer is null', async () => {
    get.mockRejectedValueOnce(new Error('503'));
    expect(await loadAiFailures({ hours: 24, tenantId: 't', tool: 'x' })).toBeNull();
  });
});

describe('★★ the contract keeps the rows that parse', () => {
  it('drops one odd row, keeps the rest; a null code and a missing ms read as none', () => {
    const parsed = aiFailuresSchema.parse({
      hours: 24,
      total: 2,
      groups: [
        { tool: 'a', errorCode: '', count: 2, tenants: 1, lastAt: '2026-11-18T07:00:00Z' },
        { count: 1 },
      ],
      recent: [
        {
          id: 'r1',
          tenantId: 't1',
          conversationId: null,
          at: '2026-11-18T07:00:00Z',
          tool: 'a',
          errorCode: null,
        },
        { id: 'r2' },
      ],
    });
    expect(parsed.groups).toEqual([
      { tool: 'a', errorCode: null, count: 2, tenants: 1, lastAt: '2026-11-18T07:00:00Z' },
    ]);
    expect(parsed.recent).toHaveLength(1);
    expect(parsed.recent[0]).toMatchObject({ argsSummary: '', ms: null, conversationId: null });
  });

  it('absent lists read as empty', () => {
    expect(aiFailuresSchema.parse({ hours: 1, total: 0 })).toMatchObject({
      groups: [],
      recent: [],
    });
  });
});

describe('★★ the badge and the names', () => {
  it('the badge is the route’s count; unread is null, never 0', async () => {
    get.mockResolvedValueOnce({ threshold: 5, count: 2, groups: [] });
    expect(await loadAiAlertCount()).toBe(2);
    expect(call().endpoint.path).toBe('/api/system/ai-actions/alerts');
    get.mockRejectedValueOnce(new Error('403'));
    expect(await loadAiAlertCount()).toBeNull();
  });

  it('tenant names by id; unread is an empty map (the ids are shown)', async () => {
    get.mockResolvedValueOnce({
      data: [
        {
          id: 't1',
          name: 'Bloom',
          slug: 'bloom',
          status: 'ACTIVE',
          isActive: true,
          createdAt: '2026-01-01',
        },
      ],
      meta: { total: 1 },
    });
    expect([...(await loadTenantNames())]).toEqual([['t1', 'Bloom']]);
    expect(call().query).toEqual({ limit: 500 });
    get.mockRejectedValueOnce(new Error('500'));
    expect((await loadTenantNames()).size).toBe(0);
  });
});
