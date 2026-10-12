import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★ A HEBREW LOANWORD TAKES A GERESH (׳), NEVER AN ASCII APOSTROPHE.
 *
 * Twelve strings had one (2026-10-12) - "מסנג'ר", "צ'אט באתר" - and the
 * only guard was one catalogue's own test (customers). This walks every
 * Hebrew catalogue on disk, so a new one is covered the day it is added.
 */
const DIR = join(process.cwd(), 'src/i18n/messages/he');

describe('★ no ASCII apostrophe after a Hebrew letter, in any Hebrew catalogue', () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));

  it('there are catalogues to read', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s', (name) => {
    const text = readFileSync(join(DIR, name), 'utf8');
    const found = [...text.matchAll(/[א-ת]'/g)].map((m) =>
      text.slice(Math.max(0, m.index - 12), m.index + 12),
    );
    expect(found).toEqual([]);
  });
});
