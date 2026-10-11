import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ A CENTRED DIALOG IS CENTRED IN HEBREW TOO (K4, 2026-10-11).
 *
 * "Add knowledge" opened with two thirds of it off the screen in Hebrew:
 * `inset-inline-start: 50%` is LOGICAL (`right: 50%` in RTL) and `translate:
 * -50%` is PHYSICAL (always leftwards), so in Hebrew the two add up instead
 * of cancelling. Measured in Chromium with the real stylesheets: the 860
 * sheet at x = -570 on a 1440 viewport (33.7% visible), x = -607 on 1366
 * (29.4%). Centred by both inline insets and auto margins it sits at x = 290
 * and x = 253 in both directions.
 *
 * The sweep is by rule block in every stylesheet under `src`: a block that
 * pins an inline edge at 50% must not translate horizontally. Its blind spot:
 * a translate in a SECOND block for the same selector, or one set inline.
 */

const ROOT = join(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const HALF_INSET = /inset-inline-(?:start|end):\s*50%/;
/** `translate: X …` or `transform: translate(X …)` / `translateX(X)` with X not zero. */
const INLINE_SHIFT =
  /(?:^|[\s;])translate:\s*(?!0[\s;])-?[\d.]+%|translate(?:X)?\(\s*(?!0[\s,)])-?[\d.]+%/;

function blocks(css: string): { selector: string; body: string }[] {
  return [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim(),
    body: m[2]!,
  }));
}

describe('★★ a centred dialog stays on the screen in Hebrew', () => {
  it('★ Add knowledge: centred by both inline insets and auto margins', () => {
    const css = readFileSync(join(ROOT, 'features/knowledge/add/AddKnowledge.module.css'), 'utf8');
    const dialog = blocks(css).find((b) => b.selector.endsWith('.dialog'))?.body ?? '';
    expect(dialog).toMatch(/inset-inline:\s*0\s*;/);
    expect(dialog).toMatch(/margin-inline:\s*auto\s*;/);
    expect(dialog).not.toMatch(HALF_INSET);
    expect(dialog).not.toMatch(/translate/);
    // The scroller under the head: it shrinks, so the foot is never cut.
    const body = blocks(css).find((b) => b.selector.endsWith('.body'))?.body ?? '';
    expect(body).toMatch(/min-block-size:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(dialog).toMatch(/max-block-size:\s*calc\(100% - 120px\)/);
  });

  it('no stylesheet pins an inline edge at 50% and translates it sideways', () => {
    const found: string[] = [];
    for (const file of files(ROOT)) {
      const rel = file.slice(ROOT.length + 1);
      for (const { selector, body } of blocks(readFileSync(file, 'utf8'))) {
        if (HALF_INSET.test(body) && INLINE_SHIFT.test(body)) found.push(`${rel} ${selector}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('★ Roles 12e: the grant picker over the drawer, centred the same way', () => {
    const css = readFileSync(join(ROOT, 'features/roles/Roles.module.css'), 'utf8');
    const picker = blocks(css).find((b) => b.selector.endsWith('.grantPicker'))?.body ?? '';
    expect(picker).toMatch(/inset-inline:\s*0\s*;/);
    expect(picker).toMatch(/margin-inline:\s*auto\s*;/);
    expect(picker).not.toMatch(/translate/);
  });

  it('the sweep sees the defect it was written for', () => {
    const before = '.dialog { inset-inline-start: 50%; translate: -50% 0; }';
    const both = '.d { inset-inline-start: 50%; transform: translate(-50%, -50%); }';
    const fixed = '.d { inset-inline: 0; margin-inline: auto; translate: 0 -50%; }';
    const hit = (css: string) =>
      blocks(css).some(({ body }) => HALF_INSET.test(body) && INLINE_SHIFT.test(body));
    expect(hit(before)).toBe(true);
    expect(hit(both)).toBe(true);
    expect(hit(fixed)).toBe(false);
  });
});
