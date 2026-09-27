import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AskedAbout } from '@/features/analytics/AskedAbout';
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
vi.mock('@/features/analytics/load-analytics', () => ({ loadAnalytics }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getFormatter: async () => ({}),
}));
vi.mock('server-only', () => ({}));

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
    // An async server component nested inside another renders nothing, with no
    // error and nothing in a log.
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
  it('★★ states why there is no "what GOTCHA did", rather than drawing an empty tab', async () => {
    /*
     * It was held on an escalation aggregation that does not exist:
     * `ConversationHandover.reason` is a four-value code — escalation,
     * takeover, assignment, routing — with no route over it, and nothing
     * counts machine causes. An empty tab inside an assembled screen is the
     * defect this screen was built to remove, so the absence is a sentence.
     */
    const { testids } = inspect(await page());
    expect(testids).toContain('analytics-no-gotcha-section');
  });

  it('★ and there is no tab row, because two panels are not sections', async () => {
    // Two tabs where one holds a single panel is ceremony, and one of them
    // would have been named for a section with no data behind it.
    const { testids } = inspect(await page());
    expect(testids.filter((id) => /tab/i.test(id))).toEqual([]);
  });
});
