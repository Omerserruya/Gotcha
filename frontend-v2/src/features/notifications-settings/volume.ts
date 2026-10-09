/**
 * How many notifications this person actually receives.
 *
 * *"You get about 6 a day."* The design asks for observed volume, and nothing
 * serves a count over a window - `GET /api/notifications` pages (200 max,
 * newest first, with `hasMore`) and `unread-count` counts unread rather than
 * arrivals.
 *
 * So it is counted from the newest page, which is exact **unless that page is
 * full and every row on it falls inside the window** - in which case there may
 * be more we did not fetch, and the number is a floor rather than a figure.
 * The screen says which it is. Paging further to be sure would mean up to
 * dozens of round trips to put one sentence on a settings screen.
 *
 * What is NOT here is the design's projection - *"raising the automatic refund
 * limit would cut it to roughly 2"*. That is a counterfactual over history, not
 * a query, and nothing computes it.
 */

export interface ObservedVolume {
  /** Notifications that arrived inside the window. */
  readonly count: number;
  readonly days: number;
  /** True when the count is a lower bound rather than the whole story. */
  readonly atLeast: boolean;
  /** Rounded per-day rate, for the sentence the design writes. */
  readonly perDay: number;
}

export const VOLUME_WINDOW_DAYS = 7;

export function observedVolume(
  arrivals: readonly { createdAt?: string | null }[],
  hasMore: boolean,
  now: Date,
  days: number = VOLUME_WINDOW_DAYS,
): ObservedVolume {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;

  const inWindow = arrivals.filter((n) => {
    if (!n.createdAt) return false;
    const at = new Date(n.createdAt).getTime();
    // An unparseable date is not counted. A notification we cannot place in
    // time cannot support a claim about a time window.
    return Number.isFinite(at) && at >= cutoff;
  }).length;

  /*
   * The page told us everything only if it was not truncated, OR if some of
   * what it returned already falls outside the window - which proves we
   * reached back past the edge and nothing beyond it can count.
   */
  const sawPastTheEdge = inWindow < arrivals.length;
  const atLeast = hasMore && !sawPastTheEdge && arrivals.length > 0;

  return {
    count: inWindow,
    days,
    atLeast,
    perDay: Math.round(inWindow / days),
  };
}
