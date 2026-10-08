import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GOTCHA is feminine in Hebrew, everywhere (Omer, 2026-10-08): "GOTCHA ענתה,
 * למדה, יודעת, היא". The sweep found 98 strings saying "GOTCHA ענה", "GOTCHA
 * יודע", "GOTCHA לא יכול" - written one screen at a time, each one reading
 * fine on its own.
 *
 * What this reads: in every Hebrew catalogue, the word after "GOTCHA" -
 * past the adverbs that sit between a subject and its verb ("GOTCHA עוד לא
 * למד") - and fails on a masculine form from the list below.
 *
 * ⚠ Its blind spots, by construction:
 *   - a verb further along the sentence ("עונה ומעביר לצוות"), and a pronoun
 *     ("שהוא לא יודע") - the sweep fixed both by reading, nothing here sees them;
 *   - a masculine verb not on the list;
 *   - a sentence whose subject is GOTCHA without naming it.
 *   Text the platform writes (an assistant's steps) is Backend's.
 */
const MASCULINE = new Set(
  (
    'עשה ממליץ יטפל מטפל טיפל יוכל יכול שלח שולח מקבץ ידע יודע הצליח מכיר קורא ' +
    'קרא רשאי כותב יכתוב כתב יתקשר מתקשר ענה יענה צריך יתחיל מתחיל התחיל מסיים ' +
    'סיים למד לומד ילמד יתעלם מתעלם ישתמש משתמש מקבל נעצר עצר זוכר עובד מעביר ' +
    'העביר מצא מוצא החזיר מחזיר ניסח מנסח זיהה היה מצלצל מודיע בודק בדק מוקם ' +
    'יציע מציע הציע עצמו אומר אמר מבין הבין ראה שואל שאל'
  ).split(' '),
);
/**
 * ★ Not listed: a present tense spelled the same in both genders - "עונה",
 *   "עושה", "מזהה", "רואה" ("היא עונה" is right). The guard's first run
 *   flagged eleven of them.
 */

/** Words that may stand between GOTCHA and its verb. */
const BETWEEN = new Set(['לא', 'כבר', 'עוד', 'עדיין', 'גם', 'רק', 'תמיד', 'אף', 'פעם']);

/**
 * GOTCHA as an object - "ל-GOTCHA", "ב-GOTCHA", "את GOTCHA": the verb after
 * it is someone else's ("מי שמנהל את GOTCHA יכול", the person who can).
 */
const OBJECT_PREFIX = /^[לבמ][-־‑]?GOTCHA/;
const OBJECT_BEFORE = new Set(['את', 'של']);

/** Every masculine verb right after "GOTCHA" as a subject, in one string. */
export function masculineAfterGotcha(text: string): string[] {
  const hits: string[] = [];
  const words = text.split(/\s+/);
  words.forEach((word, i) => {
    if (!word.includes('GOTCHA') || OBJECT_PREFIX.test(word)) return;
    if (OBJECT_BEFORE.has(words[i - 1] ?? '')) return;
    for (const raw of words.slice(i + 1, i + 5)) {
      const next = raw.replace(/[^א-ת]/g, '');
      if (BETWEEN.has(next)) continue;
      if (MASCULINE.has(next)) hits.push(`GOTCHA ${next}`);
      return;
    }
  });
  return hits;
}

const strings = (value: unknown, path: string): [string, string][] =>
  typeof value === 'string'
    ? [[path, value]]
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k))
      : [];

describe('★★ GOTCHA is feminine in Hebrew', () => {
  it('reads the word after GOTCHA, past "לא", "עוד", "כבר"', () => {
    expect(masculineAfterGotcha('GOTCHA ענה ל־12 שיחות')).toEqual(['GOTCHA ענה']);
    expect(masculineAfterGotcha('GOTCHA עוד לא למד עליו')).toEqual(['GOTCHA למד']);
    expect(masculineAfterGotcha('מה GOTCHA עשה.')).toEqual(['GOTCHA עשה']);
    expect(masculineAfterGotcha('ש־GOTCHA יתקשר')).toEqual(['GOTCHA יתקשר']);
    expect(masculineAfterGotcha('GOTCHA ענתה, למדה, יודעת')).toEqual([]);
    expect(masculineAfterGotcha('GOTCHA עונה ומזהה')).toEqual([]);
    // GOTCHA as the object: what follows is someone else's verb.
    expect(masculineAfterGotcha('מי שמנהל את GOTCHA יכול לעזור')).toEqual([]);
    expect(masculineAfterGotcha('איש הקשר ב-GOTCHA יכול')).toEqual([]);
    expect(masculineAfterGotcha('ל-GOTCHA לא היה מה לכתוב')).toEqual([]);
  });

  it('every Hebrew catalogue', () => {
    const dir = 'src/i18n/messages/he';
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const catalogue: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        return strings(catalogue, name.slice(0, -'.json'.length)).flatMap(([key, text]) =>
          masculineAfterGotcha(text).map((hit) => `${key}: ${hit}`),
        );
      });
    expect(offenders).toEqual([]);
  });
});
