/**
 * The workspace's days.
 *
 * A period a person names ("1 to 7 October") is in the business's own days,
 * not UTC: a conversation at 22:30 UTC on 1 October is on 2 October in
 * Jerusalem. The Home chat's charts (services/ai) and the inbox's period filter
 * (services/conversation) must cut the same days, so the arithmetic lives here.
 * The time zone is the business-hours one (see tenantTimeZone in each service).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD string that is a real calendar day. */
export function isWorkspaceDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The UTC instant a workspace day starts (00:00 there). */
export function dayStart(day: string, tz: string): Date {
  const utc = new Date(`${day}T00:00:00.000Z`);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(utc);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return new Date(utc.getTime() - (asIfUtc - utc.getTime()));
  } catch {
    return utc;
  }
}

/** The workspace day of an instant. */
export function dayOf(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The calendar day after `day`. */
export function nextWorkspaceDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** [start, end) in UTC for the workspace days `from`..`to` inclusive. */
export function workspaceDayWindow(from: string, to: string, tz: string): { gte: Date; lt: Date } {
  return { gte: dayStart(from, tz), lt: dayStart(nextWorkspaceDay(to), tz) };
}
