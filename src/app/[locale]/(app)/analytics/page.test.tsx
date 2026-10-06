import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AskedAbout } from '@/features/analytics/AskedAbout';
import { KpiStrip, WhatChanged } from '@/features/analytics/OperationSummary';
import { ConversationsADay } from '@/features/analytics/ConversationsADay';

/**
 * Screen 06, assembled - and the test that would have said it was not.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE PANELS WERE FINISHED, TESTED, AND ON NO PAGE
 * ════════════════════════════════════════════════════════════════════════════
 * `TeamLoad` and `AskedAbout` each had a passing test file and **no importer**.
 * This route was the placeholder stub. Every artefact was correct and the
 * screen did not exist - the same shape as three i18n catalogues that no loader
 * enumerated, and Analytics was reported as finished on the strength of it.
 *
 * So the first assertion here is the dullest one available: the page mounts
 * both panels. `scripts/orphan-component-sweep.ts` is the general form; this is
 * the specific one, and it fails if either panel is ever unmounted again.
 *
 * Structural rather than rendered, for the reason `inbox/page.test.tsx` gives:
 * both panels are async server components, jsdom cannot render one, and
 * resolving them by hand is exactly what a browser will not do for a nested
 * one - the instrument would repair the defect it exists to find.
 */

const loadAnalytics = vi.hoisted(() => vi.fn());
const loadGotcha = vi.hoisted(() => vi.fn());
const loadTeam = vi.hoisted(() => vi.fn());
const loadSales = vi.hoisted(() => vi.fn());
const loadTopics = vi.hoisted(() => vi.fn());
const loadDaily = vi.hoisted(() => vi.fn());
vi.mock('@/features/analytics/load-analytics', () => ({
  loadAnalytics,
  loadGotcha,
  loadTeam,
  loadSales,
  loadTopics,
  loadDaily,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({}),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

const PANELS = new Set<unknown>([AskedAbout, ConversationsADay]);

function walk(
  node: ReactNode,
  asyncAncestors: readonly unknown[],
  visit: (element: ReactElement, ancestors: readonly unknown[]) => void,
): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, asyncAncestors, visit);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<{ children?: ReactNode }>;
  visit(element, asyncAncestors);
  const next = PANELS.has(element.type) ? [...asyncAncestors, element.type] : asyncAncestors;
  walk(element.props?.children, next, visit);
}

const inspect = (tree: ReactNode) => {
  const mounted: unknown[] = [];
  const nested: unknown[] = [];
  const testids: string[] = [];
  walk(tree, [], (element, ancestors) => {
    const props = element.props as { 'data-testid'?: string };
    if (props?.['data-testid']) testids.push(props['data-testid']);
    if (!PANELS.has(element.type)) return;
    mounted.push(element.type);
    if (ancestors.length > 0) nested.push(element.type);
  });
  return { mounted, nested, testids };
};

const page = async (data: Record<string, unknown> = {}) => {
  loadAnalytics.mockResolvedValue({ topics: [], ...data });
  const { default: Page } = await import('./page');
  return Page();
};

beforeEach(() => {
  loadAnalytics.mockReset();
  loadDaily.mockReset().mockResolvedValue(null);
});

describe('★★ the screen exists, which is what was missing', () => {
  it('★★ mounts both panels', async () => {
    const { mounted } = inspect(await page());

    expect(mounted, 'AskedAbout is not on the page').toContain(AskedAbout);
    expect(mounted, '"Conversations a day" is not on the page').toContain(ConversationsADay);
  });

  it('★★ neither panel is inside the other', async () => {
    // This test cannot see inside a nested async component - it does not run
    // one - so a panel inside another would be invisible to it.
    expect(inspect(await page()).nested).toEqual([]);
  });

  it('★★ both are mounted even when both reads failed', async () => {
    /*
     * `null` is "we could not read it" and each panel renders its own
     * unavailable state. Withholding a panel on a failed read would make a
     * permission look like a screen that is still being built - which is
     * exactly what this screen looked like an hour ago.
     */
    const { mounted } = inspect(await page({ topics: null }));
    expect(mounted).toHaveLength(2);
  });
});

describe('★★ the section that is not here says so', () => {
  it('★★ shows states, not explanations - the "no GOTCHA section" paragraph is gone', async () => {
    /*
     * It explained an absence (the handover cause is not recorded). 02 shows
     * states and does not explain them; GOTCHA's share is now a FIGURE in the
     * strip, which is the state the paragraph stood in for.
     */
    const { testids } = inspect(await page());
    expect(testids).not.toContain('analytics-no-gotcha-section');
  });

  it('★ the tab row is drawn - 06b-06e exist, so each tab leads somewhere', async () => {
    // Superseded 2026-10-02: the row was withheld only while four tabs had
    // nowhere to lead. Drawn in the header, the same on every tab.
    const { AnalyticsTabs } = await import('@/features/analytics/AnalyticsTabs');
    const tree = await page();
    let tabs: { current: string } | null = null;
    walk(tree, [], (element) => {
      const actions = (element.props as { actions?: ReactNode }).actions;
      if (isValidElement(actions) && actions.type === AnalyticsTabs) {
        tabs = actions.props as { current: string };
      }
    });
    expect(tabs).toEqual({ current: 'overview' });
  });
});

describe('★★ 06’s summary gets the week the loader read', () => {
  it('the findings to "What changed", the figures to the strip', async () => {
    const overview = { totalConversations: 12 };
    const insights = [{ id: 'i1' }];
    const timeSaved = { secondsSaved: 60 };
    const tree = await page({ overview, insights, timeSaved });
    const find = <T,>(type: unknown): T | null => {
      let found: T | null = null;
      walk(tree, [], (element) => {
        if (element.type === type) found = element.props as T;
      });
      return found;
    };
    expect(find<{ insights: unknown }>(WhatChanged)?.insights).toBe(insights);
    expect(find<{ overview: unknown; timeSaved: unknown }>(KpiStrip)).toEqual({
      overview,
      timeSaved,
    });
  });
});

describe('★★ 06b - ?tab=gotcha has its own reads and its own parts', () => {
  it('mounts the dark card, where it stopped, the strip, the chart and what it did - and not 06', async () => {
    const { GotchaHero, GotchaStrip, WhatItDid, WhereStopped } =
      await import('@/features/analytics/GotchaTab');
    const { AloneChart } = await import('@/features/analytics/ConversationsADay');
    loadGotcha.mockResolvedValue({
      overview: null,
      timeSaved: null,
      tools: null,
      ai: null,
      unanswered: null,
    });
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({ tab: 'gotcha' }) });
    const types: unknown[] = [];
    walk(tree, [], (element) => types.push(element.type));
    for (const part of [GotchaHero, WhereStopped, GotchaStrip, AloneChart, WhatItDid]) {
      expect(types).toContain(part);
    }
    expect(types).not.toContain(ConversationsADay);
    expect(loadAnalytics).not.toHaveBeenCalled();
  });
});

describe('★★ 06c - ?tab=team', () => {
  it('mounts the dark card, the handover, the strip and the one table - with its own reads', async () => {
    const { HandoverCard, TeamHero, TeamStrip, TeamTable } =
      await import('@/features/analytics/TeamTab');
    loadTeam.mockResolvedValue({ agents: null, aiEmployees: null, overview: null, hourly: null });
    loadAnalytics.mockClear();
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({ tab: 'team' }) });
    const types: unknown[] = [];
    walk(tree, [], (element) => types.push(element.type));
    for (const part of [TeamHero, HandoverCard, TeamStrip, TeamTable]) {
      expect(types).toContain(part);
    }
    expect(loadAnalytics).not.toHaveBeenCalled();
  });
});

describe('★★ 06d - ?tab=sales', () => {
  it('mounts its five parts with the demand read only', async () => {
    const { AskedNotGot, MoneySources, SalesHero, SalesStrip, WhatYouLost } =
      await import('@/features/analytics/SalesTab');
    loadSales.mockResolvedValue({ demand: null });
    loadAnalytics.mockClear();
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({ tab: 'sales' }) });
    const types: unknown[] = [];
    walk(tree, [], (element) => types.push(element.type));
    for (const part of [SalesHero, WhatYouLost, SalesStrip, MoneySources, AskedNotGot]) {
      expect(types).toContain(part);
    }
    expect(loadAnalytics).not.toHaveBeenCalled();
  });
});

describe('★★ 06e - ?tab=topics', () => {
  it('mounts its parts, with the same tab row marking Topics', async () => {
    const { HowTheySound, TopicByDay, TopicsHero, TopicTable, UnansweredCard } =
      await import('@/features/analytics/TopicsTab');
    const { AnalyticsTabs } = await import('@/features/analytics/AnalyticsTabs');
    loadTopics.mockResolvedValue({ week: null, before: null, unanswered: null });
    const { default: Page } = await import('./page');
    const tree = await Page({ searchParams: Promise.resolve({ tab: 'topics' }) });
    const types: unknown[] = [];
    let current: string | null = null;
    walk(tree, [], (element) => {
      types.push(element.type);
      const actions = (element.props as { actions?: ReactNode }).actions;
      if (isValidElement(actions) && actions.type === AnalyticsTabs) {
        current = (actions.props as { current: string }).current;
      }
    });
    for (const part of [TopicsHero, UnansweredCard, TopicTable, TopicByDay, HowTheySound]) {
      expect(types).toContain(part);
    }
    expect(current).toBe('topics');
  });
});

describe('★★ every tab is a window - the last row runs to the frame’s bottom', () => {
  it('each tab’s page is `fill`, enumerated from the tab registry', async () => {
    /*
     * Measured on all five: without `fill` the body stopped at its content,
     * ~200px of empty sheet under the cards, and the footers 02 puts at the
     * frame's bottom sat in the middle of the page.
     */
    const { ANALYTICS_TABS } = await import('@/features/analytics/AnalyticsTabs');
    const { PageContainer } = await import('@/shell/PageContainer');
    loadAnalytics.mockResolvedValue({ agents: [], topics: [] });
    loadGotcha.mockResolvedValue({});
    loadTeam.mockResolvedValue({ agents: null, aiEmployees: null });
    loadSales.mockResolvedValue({ demand: null });
    loadTopics.mockResolvedValue({ week: null, before: null, unanswered: null });
    const { default: Page } = await import('./page');
    for (const tab of ANALYTICS_TABS) {
      const tree = (await Page({ searchParams: Promise.resolve({ tab }) })) as ReactElement<{
        fill?: boolean;
      }>;
      expect(tree.type, tab).toBe(PageContainer);
      expect(tree.props.fill, `?tab=${tab} is not fill`).toBe(true);
    }
  });
});

describe('★ 06: "Conversations a day" in its place - the series read, handed to the chart', () => {
  it('the daily series goes to the chart; who holds what is not on Overview', async () => {
    const daily = { timezone: 'UTC', series: [] };
    loadDaily.mockResolvedValue(daily);
    const tree = await page();
    let props: { daily: unknown } | null = null;
    walk(tree, [], (element) => {
      if (element.type === ConversationsADay) props = element.props as { daily: unknown };
    });
    expect(props!.daily).toBe(daily);
    expect(loadDaily).toHaveBeenCalledWith(7);
  });
});
