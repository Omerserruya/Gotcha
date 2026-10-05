import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 04's bulk facts. `get` models `http-client.ts`'s envelope rule — unwrap
 * `data` unless `raw` — and runs the real schema (see load-customer.test.ts
 * for why a mock that returns the parsed answer cannot fail): every commerce
 * answer has `data` BESIDE `source`, and unwrapping it would lose the source.
 */
const calls = vi.hoisted(() => [] as { path: string; query?: Record<string, unknown> }[]);
let answer: (path: string, query: Record<string, unknown> | undefined) => unknown = () => {
  throw new Error('no stub');
};

vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({
    get: async (req: {
      endpoint: { path: string };
      query?: Record<string, unknown>;
      payload: { parse: (input: unknown) => unknown };
      raw?: boolean;
    }) => {
      calls.push({ path: req.endpoint.path, query: req.query });
      const body = answer(req.endpoint.path, req.query);
      if (body instanceof Error) throw body;
      const unwrapped =
        !req.raw && typeof body === 'object' && body !== null && 'data' in body
          ? (body as { data: unknown }).data
          : body;
      return req.payload.parse(unwrapped);
    },
  }),
}));

import { customerByOrder, loadCommerce, loadInsights, loadSegments } from './load-customer-facts';

beforeEach(() => {
  calls.length = 0;
});

const summary = { lifetimeValue: 2140, currency: 'ILS', orderCount: 6, lastOrderAt: null };

describe('★★ commerce — read, none, or failed; never zeros for "could not look"', () => {
  it('read: by id, and the cap said', async () => {
    answer = () => ({ source: 'woocommerce', truncated: true, data: { k1: summary } });
    const facts = await loadCommerce(['k1']);
    expect(facts).toEqual({ state: 'read', truncated: true, byId: new Map([['k1', summary]]) });
    expect(calls[0]).toEqual({
      path: '/api/commerce-context/customers/commerce-summary',
      query: { contactIds: 'k1' },
    });
  });

  it('★ no store: `none` with the reason — not an empty read', async () => {
    answer = () => ({ source: null, reason: 'no_store_connected', data: {} });
    expect(await loadCommerce(['k1'])).toEqual({ state: 'none', reason: 'no_store_connected' });
  });

  it('★ at most 100 ids a call, each id once', async () => {
    answer = () => ({ source: 'woocommerce', truncated: false, data: {} });
    const ids = Array.from({ length: 205 }, (_, i) => `k${i}`);
    await loadCommerce([...ids, 'k0']);
    expect(calls.map((c) => String(c.query?.contactIds).split(',').length)).toEqual([100, 100, 5]);
  });

  it('a failed read is `null`, and nobody is asked for nothing', async () => {
    answer = () => new Error('500');
    expect(await loadCommerce(['k1'])).toBeNull();
    calls.length = 0;
    expect(await loadCommerce([])).toEqual({ state: 'read', byId: new Map(), truncated: false });
    expect(calls).toHaveLength(0);
  });
});

describe('★★ insights and segments', () => {
  it('insights by id; a mood nobody listed is no mood, not a rejected page', async () => {
    answer = () => ({
      data: {
        k1: { conversationId: 'c1', situation: 'בקשה להחזר', inboundCount: 3, mood: 'furious' },
        k2: null,
      },
    });
    const insights = await loadInsights(['k1', 'k2']);
    expect(insights?.get('k1')).toEqual({
      conversationId: 'c1',
      situation: 'בקשה להחזר',
      inboundCount: 3,
      mood: null,
    });
    expect(insights?.get('k2')).toBeNull();
    expect(calls[0]!.query).toEqual({ ids: 'k1,k2' });
  });

  it('segments: counts with the source beside them; no store keeps its reason', async () => {
    answer = () => ({
      source: 'woocommerce',
      truncated: false,
      total: 2,
      counts: { bought_once: 0, came_back: 0, wholesale: 0, never_bought: 2 },
    });
    expect(await loadSegments()).toMatchObject({ source: 'woocommerce', total: 2 });
    answer = () => ({ source: null, reason: 'store_unreachable', counts: null });
    expect(await loadSegments()).toMatchObject({ source: null, reason: 'store_unreachable' });
  });
});

describe('★★ search by order number', () => {
  it('"#1842": the order’s customer, as a list row', async () => {
    answer = (path) =>
      path.includes('by-order')
        ? { source: 'woocommerce', contactId: 'k9', orderNumber: '1842' }
        : { data: { id: 'k9', displayName: 'Dana', channel: 'WHATSAPP', historyByChannel: {} } };
    expect(await customerByOrder('#1842')).toMatchObject({ id: 'k9', displayName: 'Dana' });
    expect(calls[0]).toEqual({
      path: '/api/commerce-context/customers/by-order',
      query: { number: '#1842' },
    });
  });

  it('a name is never sent; no match is null', async () => {
    expect(await customerByOrder('Dana')).toBeNull();
    expect(calls).toHaveLength(0);
    answer = () => ({ source: 'woocommerce', contactId: null, orderNumber: '7' });
    expect(await customerByOrder('7')).toBeNull();
  });
});
