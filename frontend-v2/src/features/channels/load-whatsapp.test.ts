import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import {
  loadChannelsConfig,
  loadEvidence,
  loadImportedThread,
  loadProfilePreview,
} from './load-whatsapp';

beforeEach(() => {
  get.mockReset();
});

describe('★★ one read: both launches, and which providers are set up', () => {
  it('reads embeddedSignupByMode and providers', async () => {
    get.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({
        embeddedSignup: { configId: 'd', configured: true },
        embeddedSignupByMode: {
          coexistence: { configId: 'c1', configured: true, inspectPath: 'business-app' },
          new_number: { configId: 'n1', configured: true, inspectPath: 'new' },
        },
        providers: { outlook: false, gmail: true },
      }),
    );
    const config = await loadChannelsConfig();
    expect(config.launches.coexistence?.configId).toBe('c1');
    expect(config.launches.coexistence?.inspectPath).toBe('business-app');
    expect(config.launches.newNumber?.configId).toBe('n1');
    expect(config.providers).toEqual({ outlook: false, gmail: true });
    expect((get.mock.calls[0]![0] as { endpoint: { path: string } }).endpoint.path).toBe(
      '/api/channels/config',
    );
  });

  it('unread: no launches, no providers - never "not set up"', async () => {
    get.mockRejectedValue(new Error('down'));
    expect(await loadChannelsConfig()).toEqual({
      launches: { coexistence: null, newNumber: null },
      providers: null,
    });
  });
});

describe('★ 13f "See the chats" at the wire', () => {
  const answering =
    (value: unknown) =>
    async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse(value);
  const path = () => (get.mock.calls.at(-1)![0] as { endpoint: { path: string } }).endpoint.path;

  it('the evidence of one suggestion; a failed read is null, never "none"', async () => {
    get.mockImplementationOnce(
      answering({ evidence: [{ question: 'q', answer: 'a', conversationId: 'v1' }] }),
    );
    expect(await loadEvidence('c7')).toEqual([
      { question: 'q', answer: 'a', occurredAt: null, variantKey: null, conversationId: 'v1' },
    ]);
    expect(path()).toBe('/api/historical-imports/candidates/c7/evidence');
    get.mockRejectedValueOnce(new Error('down'));
    expect(await loadEvidence('c7')).toBeNull();
  });

  it('one imported chat, by its conversation; a failed read (or a live one, 404) is null', async () => {
    get.mockImplementationOnce(
      answering({
        conversation: { id: 'v1', customerName: 'Dana', customerExternalId: '972' },
        messages: [
          { id: 'm1', direction: 'INBOUND', body: 'hi', messageType: 'TEXT', createdAt: 'x' },
        ],
      }),
    );
    const thread = await loadImportedThread('v1');
    expect(path()).toBe('/api/historical-imports/conversations/v1/messages');
    expect(thread?.messages[0]).toEqual({
      id: 'm1',
      direction: 'INBOUND',
      body: 'hi',
      createdAt: 'x',
    });
    get.mockRejectedValueOnce(new Error('404'));
    expect(await loadImportedThread('v1')).toBeNull();
  });
});

describe('★ 13f "Preview five" at the wire', () => {
  it('the five with most messages (the route’s order), each one’s memory; nothing learned is "none", a failed read null', async () => {
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
        if (endpoint.path === '/api/historical-imports/i1/customers')
          return payload.parse({
            customers: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, messageCount: 1 })),
          });
        if (endpoint.path.endsWith('/a/memory'))
          return payload.parse({ memory: { summary: 's', facts: [{ text: 't' }] } });
        if (endpoint.path.endsWith('/b/memory')) return payload.parse({ memory: null });
        throw new Error('down');
      },
    );
    const profiles = await loadProfilePreview('i1');
    expect(profiles?.map((p) => p.customer.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(paths).not.toContain('/api/historical-imports/customers/f/memory');
    expect(profiles?.[0]?.memory).toMatchObject({ summary: 's', facts: [{ text: 't' }] });
    expect(profiles?.[1]?.memory).toBe('none');
    expect(profiles?.[2]?.memory).toBeNull();
  });

  it('the customers unread: null', async () => {
    get.mockRejectedValueOnce(new Error('down'));
    expect(await loadProfilePreview('i1')).toBeNull();
  });
});
