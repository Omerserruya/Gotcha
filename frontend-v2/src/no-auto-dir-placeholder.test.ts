import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { typedDir } from '@/lib/typed-dir';

/**
 * ★ A field with a placeholder takes its direction from `typedDir(value)`,
 * never a fixed `dir="auto"`: `auto` reads the empty value, not the
 * placeholder, and a Hebrew placeholder with an English word in it came out
 * in the wrong order (dev, 2026-10-07: "…מה לעשות עכשיו GOTCHAאפשר להגיב").
 *
 * The sweep reads each `<input>` / `<textarea>` tag as written in .tsx under
 * src; a field built by spreading props, or in another file type, is outside
 * what it can see.
 */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });

describe('★ a placeholder is never read in the typed text’s direction', () => {
  it('no <input>/<textarea> has both a fixed dir="auto" and a placeholder', () => {
    const offenders: string[] = [];
    let fields = 0;
    for (const file of filesUnder('src')) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<(input|textarea)\b[^>]*?>/gs)) {
        fields += 1;
        if (match[0].includes('dir="auto"') && match[0].includes('placeholder')) {
          offenders.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
        }
      }
    }
    expect(fields, 'no fields found - the scan is broken').toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('empty: the page’s direction; typed into: the text’s own', () => {
    expect(typedDir('')).toBeUndefined();
    expect(typedDir('שלום')).toBe('auto');
    expect(typedDir(' ')).toBe('auto');
  });
});
