import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { loadApprovals } from './load-approvals';

const at = '2026-10-04T09:00:00.000Z';
const decided = (id: string, conversationId: string | null) => ({
  id,
  tool: 'shopify.cancel_order',
  summary: 's',
  status: 'APPROVED',
  conversationId,
  decidedAt: at,
  expiresAt: at,
  createdAt: at,
});

beforeEach(() => {
  get.mockReset();
});

describe('★★ 03c reads today’s runs, and each row’s customer once', () => {
  it('usage from local midnight; one read per conversation; a failed read is no name', async () => {
    const paths: string[] = [];
    get.mockImplementation(
      async ({
        endpoint,
        payload,
      }: {
        endpoint: { path: string };
        payload: { parse: (v: unknown) => unknown };
      }) => {
        paths.push(endpoint.path);
        if (endpoint.path.startsWith('/api/approvals?status=APPROVED')) {
          return payload.parse([
            decided('a1', 'c1'),
            decided('a2', 'c1'),
            decided('a3', 'c2'),
            decided('a4', null),
          ]);
        }
        if (endpoint.path.startsWith('/api/approvals')) return payload.parse([]);
        if (endpoint.path === '/api/conversations/c1')
          return payload.parse({ customerName: ' Dana Cohen ' });
        if (endpoint.path === '/api/conversations/c2') throw new Error('down');
        if (endpoint.path.startsWith('/api/analytics/tool-usage')) return payload.parse([]);
        return payload.parse([]);
      },
    );
    const data = await loadApprovals();
    expect(data.customerNames).toEqual({ a1: 'Dana Cohen', a2: 'Dana Cohen' });
    expect(paths.filter((p) => p === '/api/conversations/c1')).toHaveLength(1);
    expect(paths).not.toContain('/api/conversations/null');

    const usage = paths.find((p) => p.startsWith('/api/analytics/tool-usage?from='))!;
    const from = new Date(decodeURIComponent(usage.split('from=')[1]!));
    expect([from.getHours(), from.getMinutes(), from.getSeconds()]).toEqual([0, 0, 0]);
    expect(data.usageToday).toEqual([]);
  });
});
