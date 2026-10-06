import type { createFormatter } from 'next-intl';

/**
 * A campaign's moment, as 02 writes one - 24-hour, and no year that is this
 * year's. "Thursday 10:00" within a week of now (either way), "7 Oct, 16:18"
 * beyond it, and the year only when it is not the current one.
 *
 * ⚠ It was `dateStyle: 'medium', timeStyle: 'short'`, which in English is
 *   "Oct 7, 2026, 4:18 PM" - 12-hour where the inbox settled on 24, a year
 *   nobody needed, and a caption long enough to wrap its row.
 *
 * Formats through next-intl's own formatter, so the configured zone
 * (`Asia/Jerusalem`) applies and is not restated here.
 */
export function campaignWhen(
  iso: string | null,
  now: Date,
  format: Pick<ReturnType<typeof createFormatter>, 'dateTime'>,
): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.abs(at.getTime() - now.getTime()) / 86_400_000;
  const time = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
  return format.dateTime(
    at,
    days < 6
      ? { weekday: 'long', ...time }
      : {
          day: 'numeric',
          month: 'short',
          ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
          ...time,
        },
  );
}
