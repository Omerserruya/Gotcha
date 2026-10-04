/**
 * Day-first, 24-hour entry — the product's rule, which a native
 * `type="date"`, `type="time"` or `datetime-local` cannot keep: they follow the
 * BROWSER's locale, so an en-US browser shows "mm/dd/yyyy, --:-- --" with
 * AM/PM on a screen that writes 09:12 everywhere else.
 *
 * Values are stored in the forms the platform takes — `HH:mm` and an ISO day
 * (`yyyy-mm-dd`) — and only the display is ours.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * `9` · `21` · `9:30` · `09.30` · `930` · `2130` → `HH:mm`; anything else,
 * including 24:00 and 9:60, is `null`.
 */
export function parseClock(raw: string): string | null {
  const text = raw.trim();
  const separated = /^(\d{1,2})[:.](\d{2})$/.exec(text);
  const digits = /^\d{1,4}$/.test(text) ? text : null;
  let hours: number;
  let minutes: number;
  if (separated) {
    hours = Number(separated[1]);
    minutes = Number(separated[2]);
  } else if (digits !== null && digits.length <= 2) {
    hours = Number(digits);
    minutes = 0;
  } else if (digits !== null) {
    // The last two digits are the minutes: `930` is 9:30, `2130` is 21:30.
    hours = Number(digits.slice(0, -2));
    minutes = Number(digits.slice(-2));
  } else {
    return null;
  }
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

/** `dd/mm/yyyy` (also `.` or `-`, and a two-digit year) → `yyyy-mm-dd`, a real day only. */
export function parseDay(raw: string): string | null {
  const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(raw.trim());
  if (!parts) return null;
  const day = Number(parts[1]);
  const month = Number(parts[2]);
  const year = parts[3]!.length === 2 ? 2000 + Number(parts[3]) : Number(parts[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `yyyy-mm-dd` → `dd/mm/yyyy`; the identity on anything else. */
export function showDay(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : iso;
}

/** A local day and clock → the instant, as ISO. */
export function localInstant(day: string, clock: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = clock.split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, hh, mm).toISOString();
}
