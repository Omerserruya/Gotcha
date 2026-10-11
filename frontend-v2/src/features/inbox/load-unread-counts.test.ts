import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ⚠ No request leaves this file: `serverApi` is mocked. */
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

import { INBOX_VIEW_IDS } from './inbox-views';
import { loadUnreadCounts } from './load-unread-counts';

const answering =
  (value: unknown) =>
  async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(value);

beforeEach(() => {
  get.mockReset();
});

describe('★★ the per-view unread counts (agreed, not yet deployed)', () => {
  it('★ asks the agreed route for every view, and keeps the counts it answers', async () => {
    get.mockImplementation(answering({ queue: 3, mine: 0, nonsense: 9 }));
    await expect(loadUnreadCounts()).resolves.toEqual({ queue: 3, mine: 0 });
    const asked = get.mock.calls[0]?.[0] as {
      endpoint: { path: string };
      query: { views: string };
      raw?: boolean;
    };
    expect(asked.endpoint.path).toBe('/api/conversations/unread-counts');
    // ⚠ Only real view ids: the route 400s an unknown one.
    expect(asked.query.views.split(',')).toEqual([...INBOX_VIEW_IDS]);
    // `{ data: {…} }` is unwrapped by the client - `raw` would parse the envelope.
    expect(asked.raw).toBeUndefined();
  });

  it('⚠⚠ a 404 (today) is "no count" - null, never zeros', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 404 }));
    await expect(loadUnreadCounts()).resolves.toBeNull();
  });

  it('⚠ any other failure is "no count" too, and never throws', async () => {
    get.mockRejectedValue(new Error('socket hang up'));
    await expect(loadUnreadCounts()).resolves.toBeNull();
    get.mockRejectedValue(new ApiError({ kind: 'server', status: 500 }));
    await expect(loadUnreadCounts()).resolves.toBeNull();
  });
});
