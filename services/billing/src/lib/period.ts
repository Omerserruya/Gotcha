/**
 * Billing-period helpers. Periods are billing-cycle anchored (not calendar),
 * so the included-Units reset and the auto-purchase monthly-spend window both
 * align to the subscription's own anchor day.
 */

/** Stable key for a period, derived from its start (e.g. "2026-06"). */
export function periodKeyFor(start: Date): string {
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Add N months preserving the anchor day-of-month where possible. */
export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  // Clamp to the month's last day (e.g. anchor 31 → Feb 28).
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

export interface Period {
  start: Date;
  end: Date;
  key: string;
}

/** The current monthly period beginning at `anchor`. */
export function currentPeriod(anchor: Date): Period {
  const start = anchor;
  const end = addMonths(anchor, 1);
  return { start, end, key: periodKeyFor(start) };
}

/** The next monthly period following `periodEnd`. */
export function nextPeriod(periodEnd: Date): Period {
  return { start: periodEnd, end: addMonths(periodEnd, 1), key: periodKeyFor(periodEnd) };
}
