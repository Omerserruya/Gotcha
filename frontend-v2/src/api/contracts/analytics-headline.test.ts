import { describe, expect, it } from 'vitest';

import {
  analyticsOverviewSchema,
  hasComparison,
  headlineMetrics,
  type AnalyticsOverview,
} from './analytics';

/**
 * Screen 06's metric strip.
 *
 * The design draws five figures each with a comparison. Three comparisons
 * exist, all as percentages, and one of the three belongs to a different
 * metric than the one it looks like it belongs to.
 */

const overview = (over: Record<string, unknown> = {}): AnalyticsOverview =>
  analyticsOverviewSchema.parse({
    totalConversations: 2840,
    resolvedConversations: 2670,
    resolutionRate: 94,
    aiHandledPct: 88,
    totalMessages: 9100,
    pendingApprovalCount: 3,
    deltas: { totalConversationsPct: 12, resolvedConversationsPct: 100, totalMessagesPct: 8 },
    ...over,
  });

const find = (o: AnalyticsOverview, key: string) => headlineMetrics(o).find((m) => m.key === key)!;

describe('★★ a delta belongs to the metric it was computed for', () => {
  it('★★ pairs the resolved DELTA with the resolved COUNT, never with the rate', () => {
    /*
     * THE TRAP. `resolvedConversationsPct` is the change in the count of
     * resolved conversations; the design's "Resolved · 94%" is the rate.
     * They can move in opposite directions - a week with twice the volume
     * and an identical rate shows +100% beside a number that did not change.
     *
     * The fixture says exactly that: rate 94, count delta +100%.
     */
    const resolved = find(overview(), 'resolved');
    expect(resolved.value).toBe(2670);
    expect(resolved.deltaPct).toBe(100);
    // And the rate is not on the strip carrying somebody else's movement.
    expect(headlineMetrics(overview()).some((m) => m.value === 94)).toBe(false);
  });

  it('carries the two comparisons that are genuinely a pair', () => {
    expect(find(overview(), 'conversations').deltaPct).toBe(12);
    expect(find(overview(), 'messages').deltaPct).toBe(8);
  });
});

describe('★★ three ways to have no comparison, and they are different sentences', () => {
  it('★★ "no baseline" is not "no change"', () => {
    /*
     * `null` means the prior period had a zero denominator - the normal
     * state for a tenant in its first period. Rendering it as "flat" would
     * tell a brand-new workspace that nothing has changed since a week that
     * does not exist.
     */
    const fresh = overview({ deltas: { totalConversationsPct: null } });
    const metric = find(fresh, 'conversations');
    expect(metric.deltaPct).toBeNull();
    expect(hasComparison(metric)).toBe(false);
  });

  it('★★ "nobody computes this" is not "no baseline" either', () => {
    /*
     * `undefined` - the metric has no delta field at all. Distinct from
     * null: one is "we could not compare this period", the other is "this
     * comparison does not exist anywhere". The screen says neither as 0%.
     */
    const handled = find(overview(), 'handledWithoutYou');
    expect(handled.deltaPct).toBeUndefined();
    expect(hasComparison(handled)).toBe(false);
  });

  it('★ an absent deltas block leaves every comparison unmade, not zero', () => {
    const none = overview({ deltas: undefined });
    for (const metric of headlineMetrics(none)) {
      expect(hasComparison(metric), `${metric.key} claimed a comparison`).toBe(false);
      expect(metric.deltaPct ?? null).toBeNull();
    }
  });

  it('a real zero IS a comparison, and says so', () => {
    // 0% means measured and unchanged. That is the one case where "flat" is
    // the true word, and it must survive the checks above.
    const flat = overview({ deltas: { totalConversationsPct: 0 } });
    expect(hasComparison(find(flat, 'conversations'))).toBe(true);
  });
});

describe('★ the strip shows what exists and invents nothing', () => {
  it('★★ never reconstructs the prior period from the percentage', () => {
    /*
     * The design asks for the comparison "in the same unit as the metric" -
     * "up 140 conversations". That means `current / (1 + pct/100)`, which is
     * a derived number a reader cannot tell from a recorded one, with
     * rounding error, in a headline. No metric carries an absolute delta.
     */
    for (const metric of headlineMetrics(overview())) {
      expect(Object.keys(metric)).not.toContain('deltaAbsolute');
      expect(Object.keys(metric)).not.toContain('previousValue');
    }
  });
});
