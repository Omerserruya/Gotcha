import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The phone's frame and main can never be scrolled from script (2026-11-15):
 * Omer's customer screen opened shifted up by exactly the bar's 58pt - an
 * `overflow: hidden` box scrolled by focus or navigation, which nothing
 * scrolls back. `clip` cannot be scrolled; `hidden` stays before it as the
 * fallback for a WebView without `clip`.
 */
const css = readFileSync('src/shell/mobile/MobileShell.module.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const body = (name: string) => new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe.each(['frame', 'main'])('★★ .%s cannot be scrolled from script', (name) => {
  it('★★ clip, after hidden - the later one wins where it is understood', () => {
    const overflows = [...body(name).matchAll(/overflow:\s*([a-z]+)\s*;/g)].map((m) => m[1]);
    expect(overflows).toEqual(['hidden', 'clip']);
  });

  it('★ no axis that scrolls', () => {
    expect(body(name)).not.toMatch(/overflow(-[xy]|-block|-inline)?:\s*(auto|scroll)/);
  });
});
