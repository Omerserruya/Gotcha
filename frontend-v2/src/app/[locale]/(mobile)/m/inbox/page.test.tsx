import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The phone inbox's views for one person (Omer, 2026-11-15), read from the tree it returns. */
const loadInbox = vi.hoisted(() => vi.fn());
vi.mock('@/features/inbox/load-inbox', () => ({ loadInbox }));
vi.mock('@/features/inbox/load-filter-chips', async () => ({
  loadFilterChips: async () => (await import('@/features/inbox/inbox-views')).FALLBACK_FILTER_CHIPS,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => 'he',
}));
vi.mock('server-only', () => ({}));
const redirect = vi.hoisted(() =>
  vi.fn((to: unknown) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to });
  }),
);
vi.mock('@/i18n/navigation', () => ({ Link: 'a', redirect }));

import { MobileConversationList } from '@/features/mobile/inbox/MobileConversationList';
import { RailUnreadCounts } from '@/shell/rail-counts';

const elements = (node: ReactNode, out: ReactElement[] = []): ReactElement[] => {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, ReactNode>)) {
      elements(value, out);
    }
  }
  return out;
};

const data = (over: Record<string, unknown> = {}) => ({
  rows: [],
  hasMore: false,
  nextCursor: null,
  undatedCount: 0,
  viewTotal: 0,
  open: null,
  missing: null,
  detail: null,
  meId: 'me',
  role: 'ADMIN',
  soleHuman: false,
  colleagues: [],
  greeting: null,
  ...over,
});

const page = async (over: Record<string, unknown> = {}, query: Record<string, string> = {}) => {
  loadInbox.mockResolvedValue(data(over));
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(query) });
};

const chips = (tree: ReactNode) =>
  elements(tree)
    .map((e) => (e.props as Record<string, unknown>)['data-testid'])
    .filter((id): id is string => typeof id === 'string' && id.startsWith('mobile-view-'))
    .map((id) => id.slice('mobile-view-'.length));

const lit = (tree: ReactNode) =>
  elements(tree).find((e) => {
    const p = e.props as Record<string, unknown>;
    return (
      String(p['data-testid'] ?? '').startsWith('mobile-view-') && p['aria-current'] === 'page'
    );
  })?.props as Record<string, unknown> | undefined;

const counted = (tree: ReactNode) =>
  (elements(tree).find((e) => e.type === RailUnreadCounts)?.props as { views: string[] }).views;

beforeEach(() => {
  loadInbox.mockReset();
  redirect.mockClear();
});

describe("★★ one person: the phone's chips are All, Open, GOTCHA, Resolved", () => {
  it('★★ the chips and their counts', async () => {
    const tree = await page({ soleHuman: true });
    expect(chips(tree)).toEqual(['all', 'open', 'gotcha', 'resolved']);
    expect(counted(tree)).toEqual(['all', 'open', 'gotcha', 'resolved']);
    // The bare inbox is "Open".
    expect(lit(tree)?.['data-testid']).toBe('mobile-view-open');
  });

  it('★★ a team keeps its six, and never asks the counts for `open`', async () => {
    const tree = await page();
    expect(chips(tree)).toEqual(['all', 'queue', 'mine', 'active', 'gotcha', 'resolved']);
    expect(counted(tree)).not.toContain('open');
    expect(lit(tree)?.['data-testid']).toBe('mobile-view-mine');
  });

  it.each(['queue', 'mine', 'active'])(
    '★★ a named `?view=%s` lands on `?view=open`, the channel and search kept',
    async (old) => {
      await expect(
        page({ soleHuman: true }, { view: old, channel: 'WHATSAPP', q: 'dana', cursor: 'k1' }),
      ).rejects.toThrow('NEXT_REDIRECT');
      expect(redirect).toHaveBeenCalledWith({
        href: { pathname: '/m/inbox', query: { view: 'open', channel: 'WHATSAPP', q: 'dana' } },
        locale: 'he',
      });
    },
  );

  it("★ a team's `?view=queue` is the queue", async () => {
    const tree = await page({}, { view: 'queue' });
    expect(redirect).not.toHaveBeenCalled();
    expect(lit(tree)?.['data-testid']).toBe('mobile-view-queue');
  });
});

describe("★ the list is told it is one person, for its rows' tags", () => {
  it.each([true, false])('soleHuman: %s', async (soleHuman) => {
    const tree = await page({ soleHuman });
    const list = elements(tree).find((e) => e.type === MobileConversationList);
    expect((list?.props as { soleHuman?: boolean }).soleHuman).toBe(soleHuman);
  });
});
