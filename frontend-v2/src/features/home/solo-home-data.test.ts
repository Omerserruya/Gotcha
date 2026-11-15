import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home for one person (Omer, 2026-11-15): with auto-assign nothing waits, so
 * the queue is always 0. Home counts and lists that person's Open
 * conversations - the inbox's own `open` view - and is quiet when there are none.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('server-only', () => ({}));

import { loadHomeData } from './load-home-data';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  status: 'OPEN',
  channel: 'WHATSAPP',
  handledBy: 'human',
  assignedAgentId: 'u1',
  assignedAiAgentId: null,
  isHandedOver: true,
  lastMessageAt: '2026-11-15T09:00:00Z',
  customerName: 'Dana',
  customerExternalId: '+972541234567',
  contactId: null,
  lastMessageBody: 'Where is my order?',
  lastMessageType: 'text',
  lastMessageDirection: 'INBOUND',
  departmentId: null,
  createdAt: '2026-11-15T08:00:00Z',
  ...over,
});

type Answer = {
  me?: Record<string, unknown> | 'fails';
  list?: Record<string, unknown> | 'fails';
  waiting?: number;
};

const answer = ({ me = {}, list, waiting = 0 }: Answer) =>
  get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
    const path = endpoint.path;
    if (path === '/api/auth/me') {
      if (me === 'fails') throw new Error('me down');
      return { user: { id: 'u1' }, ...me };
    }
    if (path === '/api/conversations') {
      if (list === 'fails' || list === undefined) throw new Error('list down');
      return list;
    }
    if (path.endsWith('/analytics/queue')) return { waiting };
    throw new Error(`not this test's: ${path}`);
  });

const listCalls = () =>
  get.mock.calls.filter(
    (c) => (c[0] as { endpoint: { path: string } }).endpoint.path === '/api/conversations',
  );

beforeEach(() => {
  get.mockReset();
});

describe("★★ one person: Home is the inbox's Open", () => {
  it("★★ the count is the view's size, and the card its first rows, newest first", async () => {
    answer({
      me: { workspace: { soleHuman: true } },
      list: { data: [row()], page: { limit: 4, hasMore: true, nextCursor: 'k' }, viewTotal: 7 },
    });
    const data = await loadHomeData();
    expect(data.open?.count).toBe(7);
    expect(data.open?.items).toEqual([
      {
        conversationId: 'c1',
        customer: { id: '+972541234567', name: 'Dana' },
        channel: 'WHATSAPP',
        preview: 'Where is my order?',
        intent: null,
        waitingSince: '2026-11-15T09:00:00Z',
      },
    ]);
    expect((listCalls()[0]![0] as { query: Record<string, unknown> }).query).toMatchObject({
      view: 'open',
      limit: 4,
    });
    // Busy while anything is open - the queue's 0 does not make it quiet.
    expect(data.isQuiet).toBe(false);
  });

  it('★★ quiet is no open conversation', async () => {
    answer({
      me: { workspace: { soleHuman: true } },
      list: { data: [], page: { limit: 4, hasMore: false, nextCursor: null }, viewTotal: 0 },
      waiting: 3,
    });
    const data = await loadHomeData();
    expect(data.open?.count).toBe(0);
    expect(data.isQuiet).toBe(true);
  });

  it('⚠ an unread list is unread: no count, no rows - and not quiet', async () => {
    answer({ me: { workspace: { soleHuman: true } }, list: 'fails' });
    const data = await loadHomeData();
    expect(data.open).toEqual({ count: null, items: null });
    expect(data.isQuiet).toBe(false);
  });

  it('★ no size from the route: a short page is its own count, a full one is unknown', async () => {
    answer({
      me: { workspace: { soleHuman: true } },
      list: {
        data: [row(), row({ id: 'c2' })],
        page: { limit: 4, hasMore: false, nextCursor: null },
      },
    });
    expect((await loadHomeData()).open?.count).toBe(2);
    answer({
      me: { workspace: { soleHuman: true } },
      list: {
        data: ['a', 'b', 'c', 'd'].map((id) => row({ id })),
        page: { limit: 4, hasMore: true, nextCursor: 'k' },
      },
    });
    expect((await loadHomeData()).open?.count).toBeNull();
  });

  it('★ a nameless row with no handle passes no invented name', async () => {
    answer({
      me: { workspace: { soleHuman: true } },
      list: {
        data: [
          row({
            customerName: null,
            customerExternalId: null,
            lastMessageBody: null,
            lastMessageAt: null,
          }),
        ],
        page: { limit: 4, hasMore: false, nextCursor: null },
        viewTotal: 1,
      },
    });
    expect((await loadHomeData()).open?.items?.[0]).toMatchObject({
      customer: { id: '', name: null },
      preview: '',
      waitingSince: null,
    });
  });
});

describe("★★ a team - or an unread `me` - is today's Home", () => {
  it.each([
    ['a team', { workspace: { soleHuman: false } }],
    ['no flag', {}],
    ['`me` unread', 'fails' as const],
  ])('%s: no Open, the queue decides quiet, and no open list is read', async (_name, me) => {
    answer({ me, waiting: 0 });
    const data = await loadHomeData();
    expect(data.open).toBeNull();
    expect(data.isQuiet).toBe(true);
    expect(listCalls()).toHaveLength(0);
  });
});
