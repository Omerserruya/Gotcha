import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { IdentitySuggestion } from '@/api/contracts/identity';
import type * as LoadCustomers from '@/features/customers/load-customers';

const loadCustomers = vi.hoisted(() => vi.fn());
vi.mock('@/features/customers/load-customers', async (original) => ({
  ...(await original<typeof LoadCustomers>()),
  loadCustomers,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, values?: { count?: number }) =>
    values?.count === undefined ? key : `${key}:${values.count}`,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
const loadSuggestions = vi.hoisted(() =>
  vi.fn(async (): Promise<readonly IdentitySuggestion[] | null> => []),
);
vi.mock('@/features/customers/load-suggestions', () => ({ loadSuggestions }));

import { CustomerList, Segments } from '@/features/customers/CustomerList';
import { DuplicateCard } from '@/features/customers/DuplicateCard';
import { PageContainer } from '@/shell/PageContainer';

const propsOf = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === type) found = element.props as T;
    visit(element.props.children);
  };
  visit(tree);
  return found;
};

const page = async (data: Record<string, unknown>, params: Record<string, string> = {}) => {
  loadCustomers.mockResolvedValue({
    total: 0,
    truncated: false,
    searchedField: null,
    conversations: null,
    quiet: null,
    ...data,
  });
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(params) });
};

const rows = [
  { id: 'a', personId: 'p1', channel: 'WHATSAPP', displayName: 'A', externalId: 'a', tags: [] },
  { id: 'b', personId: 'p1', channel: 'INSTAGRAM', displayName: 'A', externalId: 'b', tags: [] },
  { id: 'c', personId: null, channel: 'WHATSAPP', displayName: 'C', externalId: 'c', tags: [] },
];

describe('★★ 04 - the count is the title', () => {
  it('★★ in PEOPLE - two contacts of one person are one customer', async () => {
    const props = propsOf<{ title: string; fill?: boolean }>(
      await page({ rows, total: 3 }),
      PageContainer,
    );
    expect(props?.title).toBe('titleCount:2');
    expect(props?.fill).toBe(true);
  });

  it('⚠⚠ and not when the list is cut - `total` counts records', async () => {
    const props = propsOf<{ title: string }>(
      await page({ rows, total: 4180, truncated: true }),
      PageContainer,
    );
    expect(props?.title).toBe('title');
  });
});

describe('★★ 04 - the segment is in the URL, and the counts are live', () => {
  const dana = { id: 'k1', externalId: 'wa-1', displayName: 'Dana', channel: 'WHATSAPP', tags: [] };
  const rotem = {
    id: 'k2',
    externalId: 'wa-2',
    displayName: 'Rotem',
    channel: 'WHATSAPP',
    tags: [],
  };
  const today = {
    rows: [dana, rotem],
    conversations: [
      {
        customerExternalId: 'wa-1',
        status: 'OPEN',
        // An hour ago, always: "talking now" means the last 24 hours of the clock that runs the test.
        lastMessageAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastMessageBody: 'hi',
        lastMessageDirection: 'INBOUND',
      },
    ],
    quiet: { ids: new Set(['wa-2']), count: 1, capped: false },
  };

  it('asks for the day, and counts who is talking and who went quiet', async () => {
    const tree = await page(today);
    expect(loadCustomers).toHaveBeenLastCalledWith('', { today: true });
    expect(propsOf<{ talking: number; quiet: unknown }>(tree, Segments)).toMatchObject({
      talking: 1,
      quiet: { count: 1, capped: false },
    });
  });

  it.each([
    ['talking', ['k1']],
    ['quiet', ['k2']],
    ['nonsense', ['k1', 'k2']],
  ])('?segment=%s shows %j', async (segment, ids) => {
    const tree = await page(today, { segment });
    const people = propsOf<{ people: { primary: { id: string } }[] }>(tree, CustomerList)?.people;
    expect(people?.map((p) => p.primary.id)).toEqual(ids);
  });
});

describe('★★ 04 - the pair is the server’s; none, or an unread list, is no card', () => {
  // Two customers sharing a phone, neither linked: the client once paired these itself.
  const twins = [
    {
      id: 'k1',
      personId: null,
      channel: 'WHATSAPP',
      displayName: 'Yael',
      externalId: 'a',
      phone: '0500000009',
      tags: [],
    },
    {
      id: 'k2',
      personId: null,
      channel: 'SMS',
      displayName: 'yael.b',
      externalId: 'b',
      phone: '+972500000009',
      tags: [],
    },
  ];
  const pair = (id: string, a: string, b: string): IdentitySuggestion => ({
    id,
    source: 'link',
    contactIds: [a, b],
    signal: 'same_name',
    identifier: null,
    contacts: [
      { id: a, label: 'Yael', channel: 'WHATSAPP' },
      { id: b, label: 'Instagram customer', channel: 'INSTAGRAM' },
    ],
  });
  type Card = { suggestion: IdentitySuggestion };

  it('the server’s first pair is the card, keyed by the pair', async () => {
    loadSuggestions.mockResolvedValueOnce([pair('s1', 'x1', 'x2'), pair('s2', 'x3', 'x4')]);
    const tree = await page({ rows: twins, total: 2 });
    expect(propsOf<Card>(tree, DuplicateCard)?.suggestion.contactIds).toEqual(['x1', 'x2']);
    expect(loadSuggestions).toHaveBeenCalled();
  });

  it('★★ no pair from the server: no card - two rows sharing a phone are not paired here', async () => {
    loadSuggestions.mockResolvedValueOnce([]);
    expect(propsOf<Card>(await page({ rows: twins, total: 2 }), DuplicateCard)).toBeNull();
  });

  it('the pairs unread: no card at all, never an empty one', async () => {
    loadSuggestions.mockResolvedValueOnce(null);
    expect(propsOf<Card>(await page({ rows: twins, total: 2 }), DuplicateCard)).toBeNull();
  });
});
