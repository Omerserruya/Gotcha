/**
 * 12e's "Ends": the last second of a day, in the workspace's time zone, as
 * an instant (backend 53a5079a takes ISO with an offset; `Z` is one).
 *
 * "7 days" is the end of the day seven days from today THERE - not now + 168
 * hours, which would end mid-afternoon - and the zone's offset is that DAY's,
 * so a date across a daylight-saving change ends at its own 23:59:59.
 */

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((local - at) / 60_000);
}

/** "2026-10-13" - the calendar date there, `days` from `now`. */
export function dateIn(timeZone: string, now: Date, days = 0): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 23:59:59 on `ymd` in the zone, as an ISO instant. */
export function endOfDate(ymd: string, timeZone: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59);
  // Twice: the first guess may sit across a change of offset.
  let at = wall - offsetMinutes(wall, timeZone) * 60_000;
  at = wall - offsetMinutes(at, timeZone) * 60_000;
  return new Date(at).toISOString();
}

export type Ends =
  | { readonly kind: 'none' }
  | { readonly kind: 'days'; readonly days: 7 | 30 }
  | {
      readonly kind: 'date';
      readonly date: string;
    };

/** What to send: `null` is "No end date"; a date in the past is the server's to refuse. */
export function expiresAtOf(ends: Ends, timeZone: string, now: Date = new Date()): string | null {
  if (ends.kind === 'none') return null;
  if (ends.kind === 'days') return endOfDate(dateIn(timeZone, now, ends.days), timeZone);
  return ends.date ? endOfDate(ends.date, timeZone) : null;
}
