import type { createFormatter } from 'next-intl';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A CONVERSATION'S TIME IN A LIST (Omer, 2026-10-13, I4)
 * ════════════════════════════════════════════════════════════════════════════
 *   under 24 hours   the time         16:43
 *   under 7 days     the weekday      יום ג׳ / Tue
 *   older            the date         12.10 - with the year (12.10.25) when
 *                                     it is not this year
 *
 * By elapsed time, not by calendar day: "16:43" means within the last 24
 * hours. The weekday, date and year are read in the workspace's zone - the
 * formatter's, configured once (`i18n/request.ts`) - so a row at 23:30 in
 * Jerusalem is that day there, whatever zone the server runs in.
 *
 * The date is numeric with dots in both languages, as Omer wrote it: a
 * locale's own short date ("10/12" in en) reads as December to half the
 * people who would see it.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The slice of next-intl's formatter this needs - so a test passes the real one. */
export type DateFormatter = Pick<ReturnType<typeof createFormatter>, 'dateTime'>;

export function listTime(iso: string, now: Date, format: DateFormatter): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const age = now.getTime() - at.getTime();
  // A time a little ahead of ours (clock skew) is still "now", not a week away.
  if (age < DAY) {
    return format.dateTime(at, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (age < 7 * DAY) return format.dateTime(at, { weekday: 'short' });
  const day = format.dateTime(at, { day: '2-digit' });
  const month = format.dateTime(at, { month: '2-digit' });
  const year = format.dateTime(at, { year: '2-digit' });
  return year === format.dateTime(now, { year: '2-digit' })
    ? `${day}.${month}`
    : `${day}.${month}.${year}`;
}
