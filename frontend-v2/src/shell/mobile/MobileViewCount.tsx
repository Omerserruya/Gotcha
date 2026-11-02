'use client';

import { useRailCounts } from '../rail-counts';

/**
 * How many conversations a view holds, for its chip - the rail's own count
 * (`RailUnreadCounts`), so the phone and the website say one number.
 *
 * Nothing while it is unknown, and nothing for an empty view: the design
 * leaves a chip with no conversations bare rather than writing "0".
 */
export function MobileViewCount({
  view,
  className,
}: {
  readonly view: string;
  readonly className?: string;
}) {
  const counts = useRailCounts();
  const n = counts?.totals[view];
  if (n === undefined || n === 0) return null;
  return (
    <span className={className} data-testid={`mobile-view-count-${view}`}>
      {n}
    </span>
  );
}
