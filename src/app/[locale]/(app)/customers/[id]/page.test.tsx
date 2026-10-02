import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/customers/load-customer', () => ({
  loadCustomer: vi.fn(async () => ({
    ...(await import('@/features/customers/capture-fixtures')).FIXTURE_DETAIL,
  })),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

import { CustomerActions } from '@/features/customers/CustomerActions';
import { CustomerNotes } from '@/features/customers/CustomerNotes';
import { CustomerOrders } from '@/features/customers/CustomerOrders';
import {
  CustomerHeader,
  CustomerSide,
  CustomerTimelineList,
} from '@/features/customers/CustomerScreen';
import {
  ChannelFilters,
  ConversationsSide,
  ConversationsTab,
  CustomerTabRow,
  CustomerTopBar,
} from '@/features/customers/CustomerSubtabs';
import { PageContainer } from '@/shell/PageContainer';

const mounted = (tree: ReactNode): unknown[] => {
  const found: unknown[] = [];
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    found.push(node.type);
    visit((node as ReactElement<{ children?: ReactNode }>).props.children);
  };
  visit(tree);
  return found;
};

const page = async (tab?: string, channel?: string) => {
  const { default: Page } = await import('./page');
  return Page({
    params: Promise.resolve({ id: 'k1' }),
    searchParams: Promise.resolve({ ...(tab ? { tab } : {}), ...(channel ? { channel } : {}) }),
  });
};

const propsOf = <T,>(tree: ReactNode, type: unknown): T | null => {
  let found: T | null = null;
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement(node)) return;
    if (node.type === type) found = node.props as T;
    visit((node as ReactElement<{ children?: ReactNode }>).props.children);
  };
  visit(tree);
  return found;
};

describe('★★ 04b — the card, its tabs, its side', () => {
  it('a screen, flush, with the side column always', async () => {
    const tree = await page();
    expect(mounted(tree)).toContain(PageContainer);
    expect(mounted(tree)).toContain(CustomerSide);
    expect(mounted(tree)).toContain(CustomerTimelineList);
    // Everything alone carries 04b's large header.
    expect(mounted(tree)).toContain(CustomerHeader);
    expect(mounted(tree)).not.toContain(CustomerTopBar);
  });

  it.each(['conversations', 'orders', 'actions', 'notes'])(
    '★★ ?tab=%s has 04c–04f’s compact header and tab row, not 04b’s header',
    async (tab) => {
      const types = mounted(await page(tab));
      expect(types).toContain(CustomerTopBar);
      expect(types).toContain(CustomerTabRow);
      expect(types).not.toContain(CustomerHeader);
    },
  );

  it('★★ 04c: the spine, its own side, and the channel filters in the tab row', async () => {
    const tree = await page('conversations');
    const types = mounted(tree);
    expect(types).toContain(ConversationsTab);
    expect(types).toContain(ConversationsSide);
    expect(types).not.toContain(CustomerSide);
    const filters = propsOf<{ filters: ReactElement }>(tree, CustomerTabRow)?.filters;
    expect(isValidElement(filters) && filters.type).toBe(ChannelFilters);
  });

  it('⚠ ?channel= passes through only when they use that channel', async () => {
    const { FIXTURE_DETAIL } = await import('@/features/customers/capture-fixtures');
    const used = FIXTURE_DETAIL.timeline!.events.find((e) => e.channel)!.channel!;
    expect(
      propsOf<{ channel: string | null }>(await page('conversations', used), ConversationsTab)
        ?.channel,
    ).toBe(used);
    expect(
      propsOf<{ channel: string | null }>(await page('conversations', 'FAX'), ConversationsTab)
        ?.channel,
    ).toBeNull();
  });

  it.each([
    ['orders', CustomerOrders],
    ['actions', CustomerActions],
    ['notes', CustomerNotes],
  ] as const)('★ ?tab=%s shows that panel, and not the timeline', async (tab, panel) => {
    const types = mounted(await page(tab));
    expect(types).toContain(panel);
    expect(types).not.toContain(CustomerTimelineList);
  });
});
