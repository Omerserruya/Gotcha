import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No em dash and no en dash anywhere in v2's source (Omer, 2026-10-06: "a
 * clear sign of AI"). Copy, titles, placeholders, the empty-value marker and
 * comments all use a plain hyphen: " - " between phrases, "-" in a range and
 * as the empty cell.
 *
 * ★ Built from code points, so this file is not itself a hit. Model text
 *   arriving at runtime is `plainDashes`'s, not this guard's.
 * ⚠ Its blind spot: a string assembled at runtime from code points, as
 *   `plain-dashes.ts` does on purpose to find them.
 */
const FORBIDDEN = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
const EXTENSIONS = /\.(ts|tsx|json|css|md|mjs)$/;

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return EXTENSIONS.test(entry.name) ? [path] : [];
  });

describe('★★ no em or en dash in src', () => {
  it('every file under src: ts, tsx, json, css, md', () => {
    const offenders: string[] = [];
    for (const file of filesUnder('src')) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.some((ch) => line.includes(ch))) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
