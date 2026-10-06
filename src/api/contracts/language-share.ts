import { z } from 'zod';

/**
 * The language mix of recent conversations - screen 11d.
 *
 * `GET /api/analytics/language-share`, grouped on
 * `Conversation.detectedLocale` over a trailing window.
 *
 * The design's line is *"4% of last month's conversations were in Russian"*,
 * and the point of it is to let somebody notice a language they are not
 * equipped for. Measured on this tenant: **he 76, en 12, and one
 * conversation whose language was never detected.**
 */

export const languageShareRowSchema = z.object({
  /**
   * `null` when the language was never detected.
   *
   * A row like any other, and **not a language**. Rendering it as one would
   * invent a locale; dropping it would quietly change the denominator the
   * percentages were computed against.
   */
  locale: z.string().nullable().default(null),
  conversations: z.number().default(0),
  /** Already a percentage, to one decimal, computed server-side. */
  share: z.number().default(0),
});

export const languageShareSchema = z.object({
  windowDays: z.number().default(30),
  total: z.number().default(0),
  rows: z.array(languageShareRowSchema).default([]),
});

export type LanguageShare = z.infer<typeof languageShareSchema>;
export type LanguageShareRow = z.infer<typeof languageShareRowSchema>;

/** The rows that name a language, in the order the service sorted them. */
export function namedLanguages(share: LanguageShare): readonly LanguageShareRow[] {
  return share.rows.filter((r) => r.locale !== null);
}

/** The row for conversations whose language was never worked out. */
export function undetected(share: LanguageShare): LanguageShareRow | null {
  return share.rows.find((r) => r.locale === null) ?? null;
}

/**
 * Is there enough here to say anything?
 *
 * A handful of conversations produces percentages that look authoritative and
 * move twenty points on one more chat. The screen shows counts either way and
 * withholds the SHARES below this, which is the same reasoning as
 * `MIN_SAMPLE_CONVERSATIONS` on the credits estimate - a rate needs a sample.
 */
export const MIN_FOR_SHARES = 20;

export function sharesAreMeaningful(share: LanguageShare): boolean {
  return share.total >= MIN_FOR_SHARES;
}

/**
 * Languages the business is answered in that the workspace does not store.
 *
 * The design's Russian line. `stored` is the single `primaryLanguage`, and
 * every other detected language is one GOTCHA was not told about - which is
 * worth showing even though the AI replies in the customer's language
 * regardless, because it is the signal that a market exists.
 */
export function unstoredLanguages(
  share: LanguageShare,
  stored: string | null | undefined,
): readonly LanguageShareRow[] {
  const known = stored?.toLowerCase().slice(0, 2) ?? null;
  return namedLanguages(share).filter((r) => r.locale !== known);
}
