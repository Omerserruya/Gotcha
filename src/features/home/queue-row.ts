/**
 * The pure parts of a queue row.
 *
 * Separated so they can be tested without standing up a Server Component and
 * a translation runtime — these are the two places the row can quietly get a
 * customer's identity or their waiting time wrong.
 */

/**
 * Waiting time, rendered as the design does: minutes under an hour, then hours.
 *
 * Computed on the server, so it is a snapshot taken when the page rendered
 * rather than a ticking clock. That matches the design and avoids a
 * server/client hydration mismatch on a value that is `Date.now()` by nature.
 */
export function waitLabel(
  waitingSince: string,
  now: number,
  t: (key: string, values: Record<string, number>) => string,
): string {
  const since = Date.parse(waitingSince);
  if (Number.isNaN(since)) return '';
  // Clamped: clock skew between services must not render a negative wait.
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  return minutes < 60
    ? t('wait.minutes', { count: minutes })
    : t('wait.hours', { count: Math.floor(minutes / 60) });
}

/**
 * Up to two initials.
 *
 * Falls back to nothing rather than to a letter from a phone number: the
 * avatar is decorative here (`aria-hidden`), and an initial derived from an
 * identifier would read as a name the product does not actually know.
 */
export function initials(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
