/**
 * 16's one way of saying when: the clock today, "Yesterday", else the date —
 * 02's "09:41" / "Yesterday" / "Yesterday 22:14". Shared by the audit rows
 * and the devices, so one screen never says the same moment two ways.
 */
export function shortWhen(at: Date, now: Date, locale: string, yesterday: string): string {
  const clock = new Intl.DateTimeFormat(locale, { timeStyle: 'short', hour12: false });
  if (sameDay(at, now)) return clock.format(at);
  if (sameDay(at, new Date(now.getTime() - DAY))) return yesterday;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at);
}

const DAY = 24 * 60 * 60 * 1000;

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
