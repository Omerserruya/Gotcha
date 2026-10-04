import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));

import { loadCustomers } from './load-customers';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  post.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse({ data: [], total: 0 }),
  );
});

describe('★★ 04 reads the day; the dialer’s search does not', () => {
  it('the newest 100 conversations, every status, and who went quiet', async () => {
    get.mockImplementation(
      async ({
        endpoint,
        query,
        payload,
      }: {
        endpoint: { path: string };
        query?: Record<string, unknown>;
        payload: { parse: (v: unknown) => unknown };
      }) => {
        if (endpoint.path === '/api/conversations') {
          expect(query).toStrictEqual({ limit: 100, cursor: '' });
          return payload.parse({ data: [{ customerExternalId: 'wa-1', status: 'OPEN' }] });
        }
        if (endpoint.path.startsWith('/api/analytics/dormant-customers')) {
          return payload.parse({ data: [{ customerId: 'wa-2' }, { customerId: null }] });
        }
        throw new Error(endpoint.path);
      },
    );
    const data = await loadCustomers('', { today: true });
    expect(data.conversations?.map((c) => c.customerExternalId)).toEqual(['wa-1']);
    expect(data.quiet).toEqual({ ids: new Set(['wa-2']), count: 2, capped: false });
  });

  it('either read failing is unknown — never "nobody"', async () => {
    get.mockImplementation(async () => {
      throw new Error('down');
    });
    const data = await loadCustomers('', { today: true });
    expect(data.conversations).toBeNull();
    expect(data.quiet).toBeNull();
  });

  it('without `today` (the dialer): no extra reads at all', async () => {
    const data = await loadCustomers('dana');
    expect(get).not.toHaveBeenCalled();
    expect(data.conversations).toBeNull();
  });
});
