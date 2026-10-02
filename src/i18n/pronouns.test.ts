import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★ WE DO NOT KNOW A CUSTOMER'S GENDER, SO THE COPY NEVER ASSUMES ONE.
 *
 * Two English strings said "her" about whoever is in the conversation —
 * "Her channels", "We can't show her other channels" — carried over from 02's
 * persona, Dana. The first sweep for them was lowercase and missed "Her".
 * Hebrew genders by grammar, so it is not swept by word: "האדם הזה" with "שלו"
 * agrees with the noun and assumes nothing; a feminine form about a customer
 * would. Both "her" strings' Hebrew now say "של האדם הזה".
 */

const DIR = join(process.cwd(), 'src/i18n/messages/en');
const GENDERED = /\b(she|her|hers|herself|he|him|his|himself)\b/i;

function strings(value: unknown, key = ''): [string, string][] {
  if (typeof value === 'string') return [[key, value]];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, key ? `${key}.${k}` : k));
  }
  return [];
}

describe('★ the English copy assumes nobody’s gender', () => {
  it('no gendered pronoun, in any case, in any catalogue', () => {
    const found = readdirSync(DIR)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) =>
        strings(JSON.parse(readFileSync(join(DIR, name), 'utf8')))
          .filter(([, text]) => GENDERED.test(text))
          .map(([key, text]) => `${name} ${key}: ${text}`),
      );
    expect(found).toEqual([]);
  });
});
