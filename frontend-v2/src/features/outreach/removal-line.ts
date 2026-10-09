/**
 * The removal line every MARKETING template ends with (Omer, 2026-10-08:
 * marketing by opt-out). The server appends it on create, update and
 * duplicate - "\n\n" and the line - so the form draws it as a fixed last
 * line, not as typing that vanished or a line the person must remember.
 *
 * ⚠ The platform's, mirrored: `packages/shared/src/lib/marketing-optout.ts`
 *   (REMOVAL_LINE, hasRemovalLine) and `routes/templates.ts:313` - Hebrew
 *   for a language starting "he", English for every other (Arabic too).
 *   Never twice: a body that already carries either line gets none.
 */
export const REMOVAL_LINE = { he: 'להסרה השיבו הסר', en: 'Reply STOP to unsubscribe' } as const;

/** The line the server will add to this body, or `null` when it adds none. */
export function removalLineFor(category: string, language: string, body: string): string | null {
  if (category !== 'MARKETING') return null;
  const flat = body.replace(/\s+/g, ' ').toLowerCase();
  if (flat.includes(REMOVAL_LINE.he) || flat.includes(REMOVAL_LINE.en.toLowerCase())) return null;
  return language.toLowerCase().startsWith('he') ? REMOVAL_LINE.he : REMOVAL_LINE.en;
}
