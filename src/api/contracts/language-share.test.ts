import { describe, expect, it } from 'vitest';

import {
  languageShareSchema,
  namedLanguages,
  sharesAreMeaningful,
  undetected,
  unstoredLanguages,
} from './language-share';

/** As measured: he 76, en 12, one undetected. */
const MEASURED = languageShareSchema.parse({
  windowDays: 30,
  total: 89,
  rows: [
    { locale: 'he', conversations: 76, share: 85.4 },
    { locale: 'en', conversations: 12, share: 13.5 },
    { locale: null, conversations: 1, share: 1.1 },
  ],
});

describe('an undetected language is not a language', () => {
  it('keeps it out of the named list and reachable on its own', () => {
    expect(namedLanguages(MEASURED).map((r) => r.locale)).toEqual(['he', 'en']);
    expect(undetected(MEASURED)?.conversations).toBe(1);
  });

  it('★ does not drop it, which would change the denominator', () => {
    // The shares were computed against 89. Hiding the row without saying so
    // would leave percentages that do not add up and cannot be checked.
    const named = namedLanguages(MEASURED).reduce((s, r) => s + r.conversations, 0);
    expect(named).toBeLessThan(MEASURED.total);
  });

  it('returns null when every conversation was detected', () => {
    const all = languageShareSchema.parse({
      total: 2,
      rows: [{ locale: 'he', conversations: 2, share: 100 }],
    });
    expect(undetected(all)).toBeNull();
  });
});

describe('a percentage needs a sample', () => {
  it('★ withholds shares below the threshold', () => {
    /*
     * Three conversations produce percentages that look authoritative and
     * move thirty points on one more chat. Same reasoning as
     * MIN_SAMPLE_CONVERSATIONS on the credits estimate.
     */
    const thin = languageShareSchema.parse({
      total: 3,
      rows: [{ locale: 'he', conversations: 3, share: 100 }],
    });
    expect(sharesAreMeaningful(thin)).toBe(false);
  });

  it('allows them on the measured tenant', () => {
    expect(sharesAreMeaningful(MEASURED)).toBe(true);
  });
});

describe('languages the workspace was never told about', () => {
  it('★ finds the twelve English conversations against a stored Hebrew', () => {
    // The design's Russian line, on this tenant's real data.
    const unstored = unstoredLanguages(MEASURED, 'he');
    expect(unstored.map((r) => r.locale)).toEqual(['en']);
    expect(unstored[0]!.conversations).toBe(12);
  });

  it('matches on the language, not the tag', () => {
    // "he-IL" and "he" are one language to somebody choosing which to answer
    // in — the service normalises, and so does this.
    expect(unstoredLanguages(MEASURED, 'he-IL').map((r) => r.locale)).toEqual(['en']);
  });

  it('counts everything when nothing is stored', () => {
    expect(unstoredLanguages(MEASURED, null).map((r) => r.locale)).toEqual(['he', 'en']);
  });

  it('never reports the undetected row as an unstored language', () => {
    expect(unstoredLanguages(MEASURED, 'he').some((r) => r.locale === null)).toBe(false);
  });
});
