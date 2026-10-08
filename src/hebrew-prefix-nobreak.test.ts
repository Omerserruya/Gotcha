import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A Hebrew prefix stays on its word: "ב‑WordPress", never "ב-" at the end of
 * one line and "WordPress" at the start of the next (measured on dev in the
 * Woo connect page, 2026-10-08; the sweep found 195 across the catalogues).
 *
 * The rule: a prefix of one to three letters from ו ה ש כ ל ב מ, joined to a
 * Latin word, a number or a {placeholder}, takes U+2011 - the non-breaking
 * hyphen, which renders as a hyphen. Measured in Chromium at a narrow width:
 * "-" before a Latin word breaks; U+2011 holds; "-" before a digit already
 * holds; a maqaf (־) holds - so a maqaf is left as written.
 *
 * ⚠ Blind spots: text the platform writes; a breakable join other than a
 *   hyphen; a maqaf in an engine that breaks after it (Chromium does not).
 *   " - " between phrases is punctuation and is not this rule's.
 */
const BREAKABLE = /(^|[^\u05d0-\u05ea])([והשכלבמ]{1,3})-(?=([A-Za-z0-9{][^\s,.]*))/g;

/** Each breakable join in one text, as "prefix-word". */
export function breakablePrefixes(text: string): string[] {
  return [...text.matchAll(BREAKABLE)].map((m) => `${m[2]}-${m[3]}`);
}

const strings = (value: unknown, path: string): [string, string][] =>
  typeof value === 'string'
    ? [[path, value]]
    : Array.isArray(value)
      ? value.flatMap((v, i) => strings(v, `${path}[${i}]`))
      : value && typeof value === 'object'
        ? Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k))
        : [];

describe('★ Hebrew: a prefix letter stays on its word', () => {
  it('finds the breakable ones, and only those', () => {
    expect(breakablePrefixes('לוחצים Connect ב-WordPress')).toEqual(['ב-WordPress']);
    expect(breakablePrefixes('וה-API שלכם, ב-{count} שיחות, ל-12 ימים')).toEqual([
      'וה-API',
      'ב-{count}',
      'ל-12',
    ]);
    // Punctuation, a maqaf, and the non-breaking hyphen are not it.
    expect(breakablePrefixes('קוד ב‑SMS - ממשיך')).toEqual([]);
    expect(breakablePrefixes('עוד אין תוסף ל־WooCommerce')).toEqual([]);
    expect(breakablePrefixes('שיחה-WhatsApp')).toEqual([]);
  });

  it('every Hebrew catalogue', () => {
    const dir = 'src/i18n/messages/he';
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) =>
        strings(JSON.parse(readFileSync(join(dir, name), 'utf8')), name.slice(0, -5)).flatMap(
          ([key, text]) => breakablePrefixes(text).map((hit) => `${key}: ${hit}`),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
