import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

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

const page = async (data: Record<string, unknown>) => {
  loadCustomers.mockResolvedValue({ total: 0, truncated: false, searchedField: null, ...data });
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve({}) });
};

const rows = [
  { id: 'a', personId: 'p1', channel: 'WHATSAPP', displayName: 'A', externalId: 'a', tags: [] },
  { id: 'b', personId: 'p1', channel: 'INSTAGRAM', displayName: 'A', externalId: 'b', tags: [] },
  { id: 'c', personId: null, channel: 'WHATSAPP', displayName: 'C', externalId: 'c', tags: [] },
];

describe('★★ 04 — the count is the title', () => {
  it('★★ in PEOPLE — two contacts of one person are one customer', async () => {
    const props = propsOf<{ title: string; fill?: boolean }>(
      await page({ rows, total: 3 }),
      PageContainer,
    );
    expect(props?.title).toBe('titleCount:2');
    expect(props?.fill).toBe(true);
  });

  it('⚠⚠ and not when the list is cut — `total` counts records', async () => {
    const props = propsOf<{ title: string }>(
      await page({ rows, total: 4180, truncated: true }),
      PageContainer,
    );
    expect(props?.title).toBe('title');
  });
});
