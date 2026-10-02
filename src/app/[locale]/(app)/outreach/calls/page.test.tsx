import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CallStats, DialerCard, RecentCalls } from '@/features/calls/CallsScreen';

const loadCalls = vi.hoisted(() => vi.fn());
const loadLiveCall = vi.hoisted(() => vi.fn());
const loadCustomers = vi.hoisted(() => vi.fn());
vi.mock('@/features/calls/load-calls', () => ({ loadCalls, loadLiveCall }));
vi.mock('@/features/customers/load-customers', () => ({ loadCustomers }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

const find = <T,>(tree: ReactNode, type: unknown): T | null => {
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

const page = async (params: Record<string, string> = {}) => {
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(params) });
};

const reads = (over: Record<string, unknown> = {}) => ({
  voiceEnabled: true,
  hasNumber: true,
  calls: [],
  summary: null,
  failed: false,
  ...over,
});

beforeEach(() => {
  loadCalls.mockReset().mockResolvedValue(reads());
  loadLiveCall.mockReset().mockResolvedValue({ call: null, transcript: [] });
  loadCustomers
    .mockReset()
    .mockResolvedValue({ rows: [], total: 0, truncated: false, searchedField: null });
});

describe('★★ 05d — one frame in every state', () => {
  it.each([
    [{ voiceEnabled: null }, 'unknown'],
    [{ voiceEnabled: false, calls: null }, 'off'],
    [{ calls: null, failed: true }, 'failed'],
    [{ hasNumber: false }, 'noNumber'],
    [{}, 'none'],
  ] as const)(
    '%o → the recent-calls card says %s, and the dialer and the week are still drawn',
    async (over, state) => {
      loadCalls.mockResolvedValue(reads(over));
      const tree = await page();
      expect(find<{ state: string }>(tree, RecentCalls)?.state).toBe(state);
      expect(find(tree, DialerCard)).not.toBeNull();
      expect(find(tree, CallStats)).not.toBeNull();
    },
  );

  it('★ the summary is the WEEK’s — the strip says "this week"', async () => {
    await page();
    expect(loadCalls).toHaveBeenCalledWith({ summaryDays: 7 });
  });

  it('★ ?q= searches the customers; no query, no search', async () => {
    await page();
    expect(loadCustomers).not.toHaveBeenCalled();
    const tree = await page({ q: ' dana ' });
    expect(loadCustomers).toHaveBeenCalledWith('dana');
    expect(find<{ query: string }>(tree, DialerCard)?.query).toBe('dana');
  });

  it('⚠ a failed search is null, not "no match"', async () => {
    loadCustomers.mockResolvedValue({
      rows: null,
      total: 0,
      truncated: false,
      searchedField: 'name',
    });
    const tree = await page({ q: 'dana' });
    expect(find<{ results: unknown }>(tree, DialerCard)?.results).toBeNull();
  });

  it('?calls= filters the recent calls', async () => {
    const tree = await page({ calls: 'missed' });
    expect(find<{ filter: string }>(tree, RecentCalls)?.filter).toBe('missed');
  });
});
