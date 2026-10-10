import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Reads only - and mocked: nothing here reaches the platform. */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));

import { searchConversations, searchPeople } from './command-search';

const row = (id: string, name: string) => ({ id, displayName: name, phone: `+9725${id}` });
/* The route's shape: an approval parses whole or not at all. */
const approval = (id: string, contactId: string | null) => ({
  id,
  contactId,
  conversationId: `c-${id}`,
  tool: 'shopify.refund_order',
  summary: `Refund Dana Cohen · order #1842 (${id})`,
  status: 'PENDING',
  expiresAt: '2026-10-07T00:00:00Z',
  createdAt: '2026-10-06T00:00:00Z',
});

let contacts: unknown[] | Error = [];
let order: { contactId: string | null } = { contactId: null };
let approvals: unknown[] = [];

beforeEach(() => {
  contacts = [row('k1', 'Dana Cohen')];
  order = { contactId: null };
  approvals = [approval('a1', 'k1'), approval('a2', 'someone-else')];
  post
    .mockReset()
    .mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) => {
      if (contacts instanceof Error) throw contacts;
      return payload.parse({ data: contacts, total: contacts.length });
    });
  get
    .mockReset()
    .mockImplementation(
      async ({
        endpoint,
        payload,
      }: {
        endpoint: { path: string };
        payload: { parse: (v: unknown) => unknown };
      }) => {
        if (endpoint.path.startsWith('/api/approvals')) return payload.parse(approvals);
        if (endpoint.path.includes('by-order'))
          return payload.parse({ source: 'woocommerce', ...order });
        if (endpoint.path === '/api/contacts/k9')
          return payload.parse({ data: row('k9', 'Noa Gil') });
        throw new Error(endpoint.path);
      },
    );
});

const pathOf = (call: unknown[]) => (call[0] as { endpoint: { path: string } }).endpoint.path;

describe('★★ 19 - customers, and only the actions that exist', () => {
  it('a pending approval is offered only for a customer the search found', async () => {
    const found = await searchPeople('dana');
    expect(found).toMatchObject({
      ok: true,
      people: [{ id: 'k1', name: 'Dana Cohen', byOrder: null }],
      actions: [{ id: 'a1', summary: expect.stringContaining('(a1)') }],
    });
    expect(get.mock.calls.map(pathOf)).toEqual(['/api/approvals?status=PENDING']);
    // One field, by the query's shape: a name.
    expect((post.mock.calls[0]![0] as { body: unknown }).body).toEqual({
      rules: [{ field: 'name', operator: 'contains', value: 'dana' }],
    });
  });

  it('an order number asks the store too; its customer leads, marked by the order', async () => {
    contacts = [];
    order = { contactId: 'k9' };
    const found = await searchPeople('#1842');
    expect(found).toMatchObject({ ok: true, people: [{ id: 'k9', byOrder: '#1842' }] });
  });

  it('nobody found: no approvals read; a name is never sent to by-order', async () => {
    contacts = [];
    expect(await searchPeople('zz')).toEqual({
      ok: true,
      people: [],
      actions: [],
      orderMiss: null,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('★ measured on dev: an order number that found nobody says the search ran, and where', async () => {
    contacts = [];
    order = { contactId: null };
    expect(await searchPeople('1016')).toMatchObject({
      ok: true,
      people: [],
      orderMiss: { kind: 'no_match', number: '1016', source: 'woocommerce' },
    });
  });

  it('the customers read failed: said as a failure, not as nobody', async () => {
    contacts = new Error('down');
    expect(await searchPeople('dana')).toEqual({ ok: false });
  });
});

describe('★★ a conversation hit’s last word: words, or the kind of message - never "[Image]"', () => {
  const hitsOf = async (rows: unknown[]) => {
    get.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({ data: rows }),
    );
    const result = await searchConversations('dana');
    if (!result.ok) throw new Error('search failed');
    return result.hits.map((h) => ({ word: h.lastWord, kind: h.lastKind }));
  };
  const conv = (body: string | null, type?: string | null) => ({
    id: 'c1',
    lastMessageBody: body,
    ...(type === undefined ? {} : { lastMessageType: type }),
  });

  it('by its type (conversation 33e6216a), as the inbox list says it', async () => {
    expect(
      await hitsOf([
        conv('[Image]', 'image'),
        conv('[Voice message]', 'audio'),
        conv('[Shared location: Dizengoff (32.1, 34.8)]', 'location'),
        conv('', 'document'),
      ]),
    ).toEqual([
      { word: null, kind: 'photo' },
      { word: null, kind: 'voice' },
      { word: null, kind: 'location' },
      { word: null, kind: 'file' },
    ]);
  });

  it('a caption or text stays the word; an older service with no type still reads its placeholder', async () => {
    expect(
      await hitsOf([
        conv('  the  blue\none  ', 'image'),
        conv('Cancel order #1016', 'text'),
        conv('[Image]'),
        conv(null, null),
      ]),
    ).toEqual([
      { word: 'the blue one', kind: null },
      { word: 'Cancel order #1016', kind: null },
      { word: null, kind: 'photo' },
      { word: null, kind: null },
    ]);
  });
});
