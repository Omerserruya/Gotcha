import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AskedAbout } from '@/features/analytics/AskedAbout';
import { KpiStrip, WhatChanged } from '@/features/analytics/OperationSummary';
import { TeamLoad } from '@/features/analytics/TeamLoad';

/**
 * Screen 06, assembled — and the test that would have said it was not.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE PANELS WERE FINISHED, TESTED, AND ON NO PAGE
 * ════════════════════════════════════════════════════════════════════════════
 * `TeamLoad` and `AskedAbout` each had a passing test file and **no importer**.
 * This route was the placeholder stub. Every artefact was correct and the
 * screen did not exist — the same shape as three i18n catalogues that no loader
 * enumerated, and Analytics was reported as finished on the strength of it.
 *
 * So the first assertion here is the dullest one available: the page mounts
 * both panels. `scripts/orphan-component-sweep.ts` is the general form; this is
 * the specific one, and it fails if either panel is ever unmounted again.
 *
 * Structural rather than rendered, for the reason `inbox/page.test.tsx` gives:
 * both panels are async server components, jsdom cannot render one, and
 * resolving them by hand is exactly what a browser will not do for a nested
 * one — the instrument would repair the defect it exists to find.
 */

const loadAnalytics = vi.hoisted(() => vi.fn());
const loadGotcha = vi.hoisted(() => vi.fn());
const loadTeam = vi.hoisted(() => vi.fn());
const loadSales = vi.hoisted(() => vi.fn());
vi.mock('@/features/analytics/load-analytics', () => ({
  loadAnalytics,
  loadGotcha,
  loadTeam,
  loadSales,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({}),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

const PANELS = new Set<unknown>([AskedAbout, TeamLoad]);

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
  loadAnalytics.mockResolvedValue({ agents: [], topics: [], ...data });
  const { default: Page } = await import('./page');
  return Page();
};

beforeEach(() => {
  loadAnalytics.mockReset();
});

describe('★★ the screen exists, which is what was missing', () => {
  it('★★ mounts both panels', async () => {
    const { mounted } = inspect(await page());

    expect(mounted, 'AskedAbout is not on the page').toContain(AskedAbout);
    expect(mounted, 'TeamLoad is not on the page').toContain(TeamLoad);
  });

  it('★★ neither panel is inside the other', async () => {
    // This test cannot see inside a nested async component — it does not run
    // one — so a panel inside another would be invisible to it.
    expect(inspect(await page()).nested).toEqual([]);
  });

  it('★★ both are mounted even when both reads failed', async () => {
    /*
     * `null` is "we could not read it" and each panel renders its own
     * unavailable state. Withholding a panel on a failed read would make a
     * permission look like a screen that is still being built — which is
     * exactly what this screen looked like an hour ago.
     */
    const { mounted } = inspect(await page({ agents: null, topics: null }));
    expect(mounted).toHaveLength(2);
  });
});

describe('★★ the section that is not here says so', () => {
  it('★★ shows states, not explanations — the "no GOTCHA section" paragraph is gone', async () => {
    /*
     * It explained an absence (the handover cause is not recorded). 02 shows
     * states and does not explain them; GOTCHA's share is now a FIGURE in the
     * strip, which is the state the paragraph stood in for.
     */
    const { testids } = inspect(await page());
    expect(testids).not.toContain('analytics-no-gotcha-section');
  });

  it('★ and there is no tab row, because two panels are not sections', async () => {
    // Two tabs where one holds a single panel is ceremony, and one of them
    // would have been named for a section with no data behind it.
    const { testids } = inspect(await page());
    expect(testids.filter((id) => /tab/i.test(id))).toEqual([]);
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

describe('★★ 06b — ?tab=gotcha has its own reads and its own parts', () => {
  it('mounts the dark card, where it stopped, the strip, the chart and what it did — and not 06', async () => {
    const { AloneChart, GotchaHero, GotchaStrip, WhatItDid, WhereStopped } =
      await import('@/features/analytics/GotchaTab');
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
    expect(types).not.toContain(TeamLoad);
    expect(loadAnalytics).not.toHaveBeenCalled();
  });
});

describe('★★ 06c — ?tab=team', () => {
  it('mounts the dark card, the handover, the strip and the one table — with its own reads', async () => {
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

describe('★★ 06d — ?tab=sales', () => {
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
