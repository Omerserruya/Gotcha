import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ CONTENT IS NEVER CUT ON A SHORT WINDOW (Omer on a 14", 2026-10-07).
 *
 * Measured on dev: Studio · Employees' numbers strip at 11/70px on 1280×720,
 * Home's "Your team right now" at 38/146, Analytics' KPIs at 38/73. One
 * cause, in all three: a rounded card used `overflow: hidden` to clip its
 * corners - and on a flex or grid item that ALSO drops its automatic
 * minimum size, so a short frame squeezed the card and cut its content
 * instead of the page scrolling.
 *
 * The rule: a card clips its corners with `overflow: clip` (not a scroll
 * container, so it keeps its content's height) and `min-inline-size: 0`
 * (so it can still narrow as before). Only a WINDOW - a box that is meant to
 * shrink and scroll inside - keeps `hidden`, and it says so by sizing itself
 * (`block-size`, `min-block-size`, `max-block-size`) in its own file, or by
 * being composed with `fill.fillCard`, which does.
 *
 * ★ Granularity: by CSS rule, per selector within its file. A card sized by a
 *   class from another file (`fillCard`) is fine; a card whose `hidden` is
 *   meant and sized elsewhere must be named below with why. The browser scan
 *   (`e2e/no-clipping.spec.ts`) is what sees the real screens.
 */
const SRC = join(process.cwd(), 'src');

/** `hidden` on purpose: not content in a column that can be squeezed. */
const MEANT: Readonly<Record<string, string>> = {
  'shell/AppShell.module.css .surface': 'the frame panel: sized by the viewport, its main scrolls',
  'shell/AppShell.module.css .surface:has([data-owns-panels])': 'the same panel, for the inbox',
  'features/employees/hire/Hire.module.css .sheet': 'an overlay sheet; its body scrolls',
  'features/employees/hired/Hired.module.css .dialog': 'an overlay dialog; its body scrolls',
  'features/inbox/Inbox.module.css .composer':
    'a pane item that never shrinks (`.conversationPane > *` is `flex: none`)',
  'features/inbox/Inbox.module.css .photo': 'media, clipped to its frame',
};

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

/** Every rule in a stylesheet: its last selector line and its declarations. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim().split('\n').pop()!.trim(),
    body: m[2]!,
  }));
}

const SIZED = /(?<![\w-])(min-|max-)?(block-size|height)\s*:/;

/** Rounded boxes that hide their overflow and say nothing of their size. */
export function squeezable(css: string): string[] {
  const all = rules(css);
  return all
    .filter(
      ({ body }) => /border-radius/.test(body) && /(^|[\s;])overflow:\s*hidden\s*;/.test(body),
    )
    .filter(({ selector }) => {
      const name = /^\.[\w-]+/.exec(selector)?.[0];
      // Sized in any rule of the file that names it: a window.
      return !all.some(
        (r) => name && new RegExp(`\\${name}(?![\\w-])`).test(r.selector) && SIZED.test(r.body),
      );
    })
    .map(({ selector }) => selector);
}

describe('★★ no card can be squeezed and cut on a short window', () => {
  const files = cssFiles(SRC);

  it('the walk reads the stylesheets (it is not passing on an empty list)', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('every rounded box that hides its overflow is a window, or named with why', () => {
    const found = files.flatMap((path) =>
      squeezable(readFileSync(path, 'utf8')).map((s) => `${path.slice(SRC.length + 1)} ${s}`),
    );
    expect(found.filter((key) => !(key in MEANT))).toEqual([]);
  });

  it('the check sees the defect, and not line-height as a size', () => {
    expect(
      squeezable('.strip { border-radius: 14px; overflow: hidden; line-height: normal; }'),
    ).toEqual(['.strip']);
    expect(
      squeezable('.strip { border-radius: 14px; overflow: clip; min-inline-size: 0; }'),
    ).toEqual([]);
    expect(
      squeezable('.w { border-radius: 9px; overflow: hidden; } .x > .w { min-block-size: 0; }'),
    ).toEqual([]);
  });
});
