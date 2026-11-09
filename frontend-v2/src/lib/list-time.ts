import type { createFormatter } from 'next-intl';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A CONVERSATION'S TIME IN A LIST (Omer, 2026-10-13, I4)
 * ════════════════════════════════════════════════════════════════════════════
 *   under 24 hours   the time         16:43
 *   1 to 6 days      days ago         אתמול, לפני 3 ימים / Yesterday, 3 days ago
 *   7 days or more   the date         12.10 - with the year (12.10.25) when
 *                                     it is not this year
 *
 * ★ DAYS AGO (Omer, 2026-11-09, F1) replaced the weekday: "יום ג׳" made the
 *   reader work out which Tuesday. Legacy's list read "1d".."6d" too.
 *
 * The time is by elapsed time: "16:43" means within the last 24 hours. Past
 * that, days are CALENDAR days in the workspace's zone - the formatter's,
 * configured once (`i18n/request.ts`): a message from 23:00 the day before
 * yesterday, read at noon (37 hours), is "לפני 2 ימים", not "אתמול". That is
 * the meaning the phone stream's own "אתמול" chip has (MessageStream), so the
 * word means one thing in the product. The date and year are read there too,
 * so a row at 23:30 in Jerusalem is that day there, whatever zone the server
 * runs in.
 *
 * The date is numeric with dots in both languages, as Omer wrote it: a
 * locale's own short date ("10/12" in en) reads as December to half the
 * people who would see it.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The slice of next-intl's formatter this needs - so a test passes the real one. */
export type DateFormatter = Pick<ReturnType<typeof createFormatter>, 'dateTime'>;

/**
 * "Yesterday" / "3 days ago" in the reader's language - the catalogue's
 * `inbox.queue.daysAgo`, passed in so this stays a pure function a test can
 * call with the real formatter.
 */
export type DaysAgo = (days: number) => string;

/** The calendar day `at` falls on in the formatter's zone, as a UTC day number. */
function dayNumber(at: Date, format: DateFormatter): number {
  const digits = (text: string) => Number(text.replace(/\D/g, ''));
  const year = digits(format.dateTime(at, { year: 'numeric' }));
  const month = digits(format.dateTime(at, { month: 'numeric' }));
  const day = digits(format.dateTime(at, { day: 'numeric' }));
  return Date.UTC(year, month - 1, day) / DAY;
}

export function listTime(
  iso: string,
  now: Date,
  format: DateFormatter,
  daysAgo: DaysAgo,
): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const age = now.getTime() - at.getTime();
  // A time a little ahead of ours (clock skew) is still "now", not a week away.
  if (age < DAY) {
    return format.dateTime(at, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  /*
   * 24 hours or more is at least the calendar day before - except across a
   * 25-hour DST day, where it can still be "today" there. That is yesterday
   * in every sense the reader means, hence the floor of 1.
   */
  const days = Math.max(1, dayNumber(now, format) - dayNumber(at, format));
  if (days < 7) return daysAgo(days);
  const day = format.dateTime(at, { day: '2-digit' });
  const month = format.dateTime(at, { month: '2-digit' });
  const year = format.dateTime(at, { year: '2-digit' });
  return year === format.dateTime(now, { year: '2-digit' })
    ? `${day}.${month}`
    : `${day}.${month}.${year}`;
}
