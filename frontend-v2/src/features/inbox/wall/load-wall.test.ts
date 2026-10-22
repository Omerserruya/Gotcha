import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

/*
 * `serverApi` answers by path, through the CALLER'S schema - so a strict
 * envelope is tested as strict, the way the real client parses it.
 */
const answers = vi.hoisted(() => new Map<string, unknown>());
const asked = vi.hoisted(() => [] as { path: string; query?: unknown }[]);
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({
    get: async ({
      endpoint,
      payload,
      query,
    }: {
      endpoint: { path: string };
      payload: z.ZodType;
      query?: unknown;
    }) => {
      asked.push({ path: endpoint.path, query });
      const answer = answers.get(endpoint.path);
      if (answer instanceof Error) throw answer;
      return payload.parse(answer);
    },
  }),
}));
vi.mock('@/features/customers/load-customer-facts', () => ({
  loadCommerce: async () => null,
  loadInsights: async () => new Map([['k1', { mood: 'frustrated' }]]),
}));
vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));

import { loadWallPerson } from './load-wall';

const MEMORY = '/api/ai-assist/c1/customer-memory';
const HISTORY = '/api/identity/k1/conversations';

beforeEach(() => {
  answers.clear();
  asked.length = 0;
});

describe('★★ memory - exactly what the AI is given (cd504002)', () => {
  it('★ facts with a quiet source; blanks dropped; an unknown source named nothing', async () => {
    answers.set(MEMORY, {
      data: {
        conversationId: 'c1',
        facts: [
          { key: 'business_type', value: 'Boutique', confidence: 0.9, source: 'llm_live' },
          { key: 'city', value: 'Haifa', source: 'manual' },
          { key: 'empty', value: '  ', source: 'manual' },
          { key: 'size', value: 42, source: 'something_new' },
        ],
        historical: { summary: 'Buys linen.', facts: ['Prefers M'] },
      },
    });
    const { memory } = await loadWallPerson(null, 'c1');
    expect(memory).toEqual({
      facts: [
        { key: 'business_type', value: 'Boutique', source: 'conversation' },
        { key: 'city', value: 'Haifa', source: 'person' },
        { key: 'size', value: '42', source: null },
      ],
      historical: { summary: 'Buys linen.', facts: ['Prefers M'] },
    });
  });

  it('★ keyed on the conversation: read with no contact at all', async () => {
    answers.set(MEMORY, { data: { conversationId: 'c1', facts: [], historical: null } });
    expect((await loadWallPerson(null, 'c1')).memory).toEqual({ facts: [], historical: null });
  });

  it('★★ an older service (no envelope) is unread - never "knows nothing"', async () => {
    answers.set(MEMORY, '<html>404</html>');
    expect((await loadWallPerson(null, 'c1')).memory).toBeNull();
  });
});

describe('★★ history (ed8f3e1f) - keyed on the contact, strict on the envelope', () => {
  it('★★ no contact: no read made, and nothing claimed', async () => {
    answers.set(MEMORY, { data: { conversationId: 'c1', facts: [], historical: null } });
    const person = await loadWallPerson(null, 'c1');
    expect(person.history).toBeNull();
    expect(person.mood).toBeNull();
    expect(asked.map((a) => a.path)).not.toContain(HISTORY);
  });

  it('asks for 20 with the open one marked, and maps the rows', async () => {
    answers.set(HISTORY, {
      data: [
        {
          conversationId: 'c1',
          channel: 'WHATSAPP',
          status: 'OPEN',
          startedAt: '2026-10-01T10:00:00Z',
          lastMessageAt: '2026-10-06T10:00:00Z',
          messageCount: 12,
          summary: '  Asked about a late order.  ',
          isCurrent: true,
        },
        {
          conversationId: 'c0',
          channel: 'VOICE',
          status: 'CLOSED',
          startedAt: null,
          lastMessageAt: null,
          messageCount: 0,
          summary: '   ',
          isCurrent: false,
        },
      ],
      total: 24,
      hasMore: true,
    });
    const person = await loadWallPerson('k1', 'c1');
    expect(asked.find((a) => a.path === HISTORY)?.query).toEqual({ limit: 20, current: 'c1' });
    expect(person.history).toMatchObject({ total: 24, hasMore: true });
    expect(person.history?.conversations[0]).toMatchObject({
      id: 'c1',
      lastAt: '2026-10-06T10:00:00Z',
      messages: 12,
      summary: 'Asked about a late order.',
      isCurrent: true,
    });
    // A blank summary is "No summary yet", not an empty line.
    expect(person.history?.conversations[1]?.summary).toBeNull();
    expect(person.mood).toBe('frustrated');
  });

  it.each([
    ['HTML from a service not yet deployed', '<!doctype html>'],
    ['an envelope without total', { data: [] }],
  ])('★★ %s is "couldn’t read", never an empty history', async (_, answer) => {
    answers.set(HISTORY, answer);
    expect((await loadWallPerson('k1', 'c1')).history).toBeNull();
  });
});

describe('★★ orders by contact (e30900fd) - strict, and only with a contact', () => {
  const ORDERS = '/api/commerce-context/customers/k1/orders';

  it('asks for 10 in the reader’s language; reads Woo with matchedBy', async () => {
    answers.set(ORDERS, {
      source: 'woocommerce',
      orders: [{ orderId: 'o1', orderNumber: '91', matchedBy: 'email' }],
    });
    const person = await loadWallPerson('k1', 'c1');
    expect(asked.find((a) => a.path === ORDERS)?.query).toEqual({ limit: 10, locale: 'en' });
    expect(person.orders).toMatchObject({
      source: 'woocommerce',
      orders: [{ matchedBy: 'email' }],
    });
  });

  it('★★ an envelope without `orders` is unread, not "no orders"', async () => {
    answers.set(ORDERS, { source: 'woocommerce' });
    expect((await loadWallPerson('k1', 'c1')).orders).toBeNull();
  });

  it('no contact: not asked', async () => {
    await loadWallPerson(null, 'c1');
    expect(asked.map((a) => a.path)).not.toContain(ORDERS);
  });
});
