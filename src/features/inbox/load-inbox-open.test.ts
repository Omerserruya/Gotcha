import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `?c=` opens its conversation even when this view's rows do not hold it -
 * a link from Cmd-K, a notification or Approvals (measured on dev: a
 * Shopify conversation outside the queue view read "Nothing is open").
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

import { ApiError } from '@/api/client/api-error';

import { loadInbox } from './load-inbox';

const row = (id: string) => ({ id, channel: 'WHATSAPP', status: 'OPEN', customerName: id });
let byId: (id: string) => unknown;

beforeEach(() => {
  byId = (id) => row(id);
  get.mockReset().mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
    const path = endpoint.path;
    if (path === '/api/conversations') {
      return { data: [row('listed')], page: { hasMore: false, nextCursor: null }, undatedCount: 0 };
    }
    const one = /^\/api\/conversations\/([^/]+)$/.exec(path);
    if (one) {
      const answer = byId(one[1]!);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path.includes('/auth/me')) return { id: 'me', role: 'AGENT' };
    if (path.includes('/agents')) return [];
    if (path.includes('auto-greeting')) return { template: '' };
    if (path.endsWith('/messages')) return { data: [] };
    return null;
  });
});

const asked = () =>
  get.mock.calls.map((c) => (c[0] as { endpoint: { path: string } }).endpoint.path);

describe('★★ a link opens its conversation, whatever the view', () => {
  it('listed: opened from the rows, no extra read', async () => {
    const data = await loadInbox('listed');
    expect(data.open?.id).toBe('listed');
    expect(data.missing).toBeNull();
    expect(asked()).not.toContain('/api/conversations/listed');
  });

  it('★★ not in this view: read by id and opened', async () => {
    const data = await loadInbox('elsewhere');
    expect(asked()).toContain('/api/conversations/elsewhere');
    expect(data.open?.id).toBe('elsewhere');
    expect(data.missing).toBeNull();
    expect(data.detail).not.toBeNull();
  });

  it.each([404, 403])('★ %i: "isn’t available" - not "Nothing is open"', async (status) => {
    byId = () => new ApiError({ kind: status === 404 ? 'not_found' : 'authorization', status });
    const data = await loadInbox('gone');
    expect(data.open).toBeNull();
    expect(data.missing).toBe('unavailable');
    expect(data.detail).toBeNull();
  });

  it('any other failure is a failed open, said as ours', async () => {
    byId = () => new ApiError({ kind: 'server', status: 500 });
    expect((await loadInbox('x')).missing).toBe('failed');
  });

  it('no `?c=`: the first row, and nothing read by id', async () => {
    const data = await loadInbox();
    expect(data.open?.id).toBe('listed');
    expect(asked().filter((p) => /^\/api\/conversations\/[^/]+$/.test(p))).toEqual([]);
  });
});
