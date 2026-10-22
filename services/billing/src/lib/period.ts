/**
 * Billing-period helpers. Periods are billing-cycle anchored (not calendar),
 * so the included-Units reset and the auto-purchase monthly-spend window both
 * align to the subscription's own anchor day.
 */

/**
 * Both live in shared, and are re-exported here so the existing call sites in
 * this service keep their import path.
 *
 * They are NOT defined here any more. The AI gate has to compute the same spend
 * window this service accrues against, the gate cannot import from a service,
 * and two copies of that arithmetic would eventually disagree - at which point
 * usage gets through that nothing bills, or budget goes unspent. One definition
 * is the fix, not two careful ones.
 *
 * `spendWindowKey` in particular: pass the subscription, never `now`. Keying on
 * the wall clock resets a ceiling on the 1st for a customer anchored on the
 * 10th, which lets one billing cycle spend two ceilings.
 */
import { periodKeyFor } from "@chatcenter/shared";
export { periodKeyFor, spendWindowKey } from "@chatcenter/shared";

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

/**
 * The credit month that contains `now`, within a billing period that starts
 * at `periodStart` (Omer, 2026-10-07: AI credits reset EVERY month on every
 * plan, whatever the billing period's length). Months are counted from the
 * period's own anchor day, the same way a monthly period is, so for a
 * one-month period the credit month IS the billing period and the key matches
 * the renewal's. Clamped to the period's end, never past it.
 */
export function creditMonthOf(periodStart: Date, periodEnd: Date | null, now: Date): Period {
  let k = 0;
  // Count whole months from the anchor (bounded: a period never runs a century).
  while (k < 1200 && addMonths(periodStart, k + 1) <= now) k++;
  const start = addMonths(periodStart, k);
  const naturalEnd = addMonths(periodStart, k + 1);
  const end = periodEnd && periodEnd < naturalEnd ? periodEnd : naturalEnd;
  return { start, end, key: periodKeyFor(start) };
}
