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

import { ActionFilters, ActionsSide, CustomerActions } from '@/features/customers/CustomerActions';
import { CustomerNotes, NoteFilters, NotesSide } from '@/features/customers/CustomerNotes';
import { OrderFilters, OrdersSide, OrdersTab } from '@/features/customers/OrdersTab';
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

const page = async (tab?: string, channel?: string, more?: string, filter?: string) => {
  const { default: Page } = await import('./page');
  return Page({
    params: Promise.resolve({ id: 'k1' }),
    searchParams: Promise.resolve({
      ...(tab ? { tab } : {}),
      ...(channel ? { channel } : {}),
      ...(more ? { more } : {}),
      ...(filter ? { filter } : {}),
    }),
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

describe('★★ 04b - the card, its tabs, its side', () => {
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
    '★★ ?tab=%s has 04c-04f’s compact header and tab row, not 04b’s header',
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
    ['orders', OrdersTab],
    ['actions', CustomerActions],
    ['notes', CustomerNotes],
  ] as const)('★ ?tab=%s shows that panel, and not the timeline', async (tab, panel) => {
    const types = mounted(await page(tab));
    expect(types).toContain(panel);
    expect(types).not.toContain(CustomerTimelineList);
  });
});

describe('★ ?more= - older conversations, 50 events a step', () => {
  it('★ asks the loader for the larger page, and hands the step to 04c', async () => {
    const { loadCustomer } = await import('@/features/customers/load-customer');
    vi.mocked(loadCustomer).mockClear();
    const tree = await page('conversations', undefined, '2');
    expect(vi.mocked(loadCustomer)).toHaveBeenCalledWith('k1', { limit: 150 });
    expect(propsOf<{ more: number }>(tree, ConversationsTab)?.more).toBe(2);
  });

  it('⚠ only on the conversations tab - the others keep the route’s own page', async () => {
    const { loadCustomer } = await import('@/features/customers/load-customer');
    vi.mocked(loadCustomer).mockClear();
    await page('orders', undefined, '2');
    expect(vi.mocked(loadCustomer)).toHaveBeenCalledWith('k1', {});
  });
});

describe('★★ 04d - its filters in the tab row, its own side', () => {
  it('All/Open/Returns on the right of the tabs; "Across their orders" in the side', async () => {
    const tree = await page('orders', undefined, undefined, 'returns');
    const types = mounted(tree);
    expect(types).toContain(OrdersSide);
    expect(types).not.toContain(CustomerSide);
    const filters = propsOf<{ filters: ReactElement<{ current: string }> }>(
      tree,
      CustomerTabRow,
    )?.filters;
    expect(isValidElement(filters) && filters.type).toBe(OrderFilters);
    expect(filters?.props.current).toBe('returns');
    expect(propsOf<{ filter: string }>(tree, OrdersTab)?.filter).toBe('returns');
  });

  it('⚠ an unknown ?filter= is All', async () => {
    const tree = await page('orders', undefined, undefined, 'everything-please');
    expect(propsOf<{ filter: string }>(tree, OrdersTab)?.filter).toBe('all');
  });
});

describe('★★ 04e - its filters, the approvals, its own side', () => {
  it('All/GOTCHA/Team/Money in the tab row; the approvals reach the spine; "Who did what" in the side', async () => {
    const tree = await page('actions', undefined, undefined, 'money');
    const types = mounted(tree);
    expect(types).toContain(ActionsSide);
    expect(types).not.toContain(CustomerSide);
    const filters = propsOf<{ filters: ReactElement<{ current: string }> }>(
      tree,
      CustomerTabRow,
    )?.filters;
    expect(isValidElement(filters) && filters.type).toBe(ActionFilters);
    expect(filters?.props.current).toBe('money');
    const props = propsOf<{ filter: string; approvals: unknown }>(tree, CustomerActions);
    expect(props?.filter).toBe('money');
    expect(props?.approvals).toEqual([]);
    // The rules, and the shop's currency for their amounts (the fixture's ILS).
    const side = propsOf<{ policies: unknown; currency: string | null }>(tree, ActionsSide);
    expect(side?.policies).toBeTruthy();
    expect(side?.currency).toBe('ILS');
  });
});

describe('★★ 04f - its filters, its side, the name for the composer', () => {
  it('All/GOTCHA may use/Team only in the tab row; "Notes" and "What GOTCHA reads" in the side', async () => {
    const tree = await page('notes', undefined, undefined, 'teamOnly');
    const types = mounted(tree);
    expect(types).toContain(NotesSide);
    expect(types).not.toContain(CustomerSide);
    const filters = propsOf<{ filters: ReactElement<{ current: string }> }>(
      tree,
      CustomerTabRow,
    )?.filters;
    expect(isValidElement(filters) && filters.type).toBe(NoteFilters);
    expect(filters?.props.current).toBe('teamOnly');
    const props = propsOf<{ filter: string; customerName: string | null }>(tree, CustomerNotes);
    expect(props?.filter).toBe('teamOnly');
    expect(props?.customerName).toBeTruthy();
  });
});
