import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ Every edit of an AI employee lives on its page, and "Edit" opens it
 * (Omer, 2026-10-13, E2). The Edit sheet - `?edit=1` over 07 - is gone, so
 * nothing may link to it any more: a link that did would open 07 and nothing
 * over it.
 *
 * ★ Granularity: by text, over every non-test source under `src/` - an
 *   `edit: '1'` / `edit=1` query, or the sheet's own name or path. A query
 *   built under another name (`{ [k]: '1' }`) is not seen; test files are
 *   skipped because one asserts the old address opens nothing.
 */
const OLD = /\bedit:\s*['"]1['"]|[?&]edit=1\b|\bEditSheet\b|employees\/edit\//;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('★★ no link opens the old Edit sheet', () => {
  it('the pattern sees each old form (not an empty pass)', () => {
    for (const old of [
      "query: { employee: id, edit: '1' }",
      'href="/studio/employees?employee=a&edit=1"',
      "import { EditSheet } from '@/features/employees/edit/EditSheet';",
    ]) {
      expect(old).toMatch(OLD);
    }
    expect("query: { employee: id, edited: '1' }").not.toMatch(OLD);
  });

  it('no source file under src/ has one', () => {
    const all = files(join(process.cwd(), 'src'));
    expect(all.length).toBeGreaterThan(200);
    const hits = all.filter((path) => OLD.test(readFileSync(path, 'utf8')));
    expect(hits.map((p) => p.slice(process.cwd().length + 1))).toEqual([]);
  });
});
