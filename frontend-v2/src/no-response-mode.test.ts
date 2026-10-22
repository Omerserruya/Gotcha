import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ Who answers is the automations' and the playbook's to decide, not the
 * channel's (Omer, 2026-10-07). `ChannelAccount.responseMode` was read by
 * nothing at runtime; v2 no longer parses, draws or writes it, and Backend
 * removes its PATCH route once this is deployed - so no control may be left
 * pointing at it.
 *
 * ★ Granularity: by text, every file under `src` and `e2e` (this one
 *   excepted), for the field's name and its route. A value built from
 *   pieces would not be seen.
 */
const ROOTS = ['src', 'e2e'].map((dir) => join(process.cwd(), dir));
const SELF = 'no-response-mode.test.ts';
const NAMES = /responseMode|response-mode|RESPONSE_MODES/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|json|css)$/.test(name) && name !== SELF ? [path] : [];
  });
}

describe("★★ nothing in v2 names the channel's response mode", () => {
  const all = ROOTS.flatMap(files);

  it('the walk reads the tree (it is not passing on an empty list)', () => {
    expect(all.length).toBeGreaterThan(500);
  });

  it('no file names responseMode, its route or its values list', () => {
    const named = all.filter((path) => NAMES.test(readFileSync(path, 'utf8')));
    expect(named.map((p) => p.slice(process.cwd().length + 1))).toEqual([]);
  });
});
