import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ 02'S WEIGHTS STOP AT 600 - EXCEPT THE WORDMARK.
 *
 * Measured over 02's source: 600 ×535, 500 ×441, 400 ×51, and 700 ×69 - every
 * one of the 700s the GOTCHA wordmark (tracked .22/.24em). Two holes let
 * 700 in: a module setting it, and the browser's own bold on a heading,
 * `b`, `strong` or `th` that no module weighed. One test for each.
 *
 * The sweep is by rule block in every stylesheet under `src`; a weight a
 * module sets on the wordmark is allowed by its tracking, `--letter-spacing-brand`.
 */

const ROOT = join(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

const HEAVY = /font-weight:\s*(?:([7-9]00)|bold|bolder|var\(--font-weight-bold\))\s*;/;

describe('★★ nothing above 600 but the wordmark', () => {
  it('no stylesheet sets a weight above 600, except on the wordmark', () => {
    const found: string[] = [];
    for (const file of files(ROOT)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = block[2]!;
        if (!HEAVY.test(body)) continue;
        if (body.includes('var(--letter-spacing-brand)')) continue;
        found.push(`${file.slice(ROOT.length + 1)} ${block[1]!.trim()}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('★ the browser’s own bold is reset to 600 - headings, b, strong, th', () => {
    const reset = readFileSync(join(ROOT, 'design-system/styles/reset.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rule = [...reset.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((block) =>
      /font-weight:\s*var\(--font-weight-semibold\)/.test(block[2]!),
    );
    const selectors = (rule?.[1] ?? '').split(',').map((s) => s.trim());
    for (const element of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'th']) {
      expect(selectors, `${element} keeps the browser's 700`).toContain(element);
    }
  });
});
