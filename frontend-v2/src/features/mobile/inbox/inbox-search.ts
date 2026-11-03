/**
 * The phone inbox's search, as rules apart from the field (2026-11-03).
 *
 * ★ LIVE, NOT ONE PER LETTER. The list follows the field as it is typed, a
 *   pause after the last key (`SEARCH_DEBOUNCE_MS`), and only for a question
 *   worth asking: nothing (the whole list again) or two characters and more.
 *   One letter matches half the workspace and is a read nobody wanted.
 *   Enter still sends what is there, one letter included: that was asked.
 */

/** Longest search sent: a name or a phone number, not a paragraph. */
export const SEARCH_MAX = 80;

/** The shortest question the field asks by itself. */
export const SEARCH_MIN = 2;

/** The pause after the last key before the list follows. */
export const SEARCH_DEBOUNCE_MS = 300;

/** What the address's `q` should be for this text, however it was sent. */
export function searchQuery(text: string): string {
  return text.trim().slice(0, SEARCH_MAX);
}

/**
 * What typing should send: the query, or `null` when the field is not worth
 * a read yet (one character) or already says what the address says.
 */
export function liveSearch(text: string, sent: string): string | null {
  const q = searchQuery(text);
  if (q === sent) return null;
  if (q !== '' && q.length < SEARCH_MIN) return null;
  return q;
}
