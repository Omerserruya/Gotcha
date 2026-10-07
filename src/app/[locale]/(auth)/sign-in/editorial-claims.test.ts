import { describe, expect, it } from 'vitest';

import en from '@/i18n/messages/en/auth.json';
import he from '@/i18n/messages/he/auth.json';

/**
 * ★★ The sign-in editorial claims nothing it does not measure (Omer: no
 * dummy data). It said "Three hundred and forty people are mid-conversation",
 * "41,800 messages since midnight", "All systems operational" - to every
 * visitor, from a catalogue. No public route returns those aggregates, so
 * the copy carries no figure and no "right now" at all.
 *
 * ★ Granularity: every string under `editorial` and `recover.editorial`, in
 *   both locales, by value. A figure moved to another key in either is still
 *   caught; one moved into a component is not.
 */
const FIGURE = /\d|\b(hundred|thousand|million)\b|מאות|מאה|אלף|אלפים|מיליון/i;
const LIVE = /right now|since midnight|today|ברגע זה|מחצות|היום/i;

function strings(value: unknown, at: string): [string, string][] {
  if (typeof value === 'string') return [[at, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
}

const all = [
  ...strings(en.editorial, 'en.editorial'),
  ...strings(en.recover.editorial, 'en.recover.editorial'),
  ...strings(he.editorial, 'he.editorial'),
  ...strings(he.recover.editorial, 'he.recover.editorial'),
];

describe('★★ the sign-in editorial claims no figure and no "right now"', () => {
  it('there is copy to check', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all)('%s', (_at, text) => {
    expect(text).not.toMatch(FIGURE);
    expect(text).not.toMatch(LIVE);
  });

  it('no fixed health line on sign-in, in either locale', () => {
    expect('status' in en.editorial).toBe(false);
    expect('status' in he.editorial).toBe(false);
  });

  it('the check itself sees the old copy', () => {
    expect('Three hundred and forty people are mid-conversation').toMatch(FIGURE);
    expect('41,800 messages since midnight').toMatch(LIVE);
    expect('שלוש מאות וארבעים אנשים').toMatch(FIGURE);
    expect('ברגע זה, בכל החשבונות').toMatch(LIVE);
  });
});
