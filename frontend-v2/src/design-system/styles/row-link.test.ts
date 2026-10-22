import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * ★★ A ROW YOU CAN CLICK ANYWHERE (Omer, 2026-10-11) - the shared rules.
 *
 * Each screen's suite asserts its rows carry the classes; this asserts the
 * classes do what they say. Each rule is checked by its declarations, not by
 * its presence: a `.link::after {}` with no `position` is an overlay of zero
 * size that every class-name test would still pass.
 */
const css = readFileSync('src/design-system/styles/row-link.module.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null;
};

describe('★★ row-link - the row’s one link, stretched over the row', () => {
  it('the row is the overlay’s containing block', () => {
    expect(rule('.row')).toMatch(/position:\s*relative/);
  });

  it('★ the overlay: the link’s ::after covers the whole row', () => {
    const overlay = rule('.link::after');
    expect(overlay).toMatch(/content:\s*''/);
    expect(overlay).toMatch(/position:\s*absolute/);
    expect(overlay).toMatch(/inset:\s*0/);
  });

  it('★ the keyboard ring moves to the row, from tokens - never simply removed', () => {
    // The link's own ring is dropped only because the overlay draws one.
    expect(rule('.link:focus-visible')).toMatch(/outline:\s*none/);
    const ring = rule('.link:focus-visible::after');
    expect(ring).toMatch(/outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--border-focus\)/);
    // Inset, so a card's `overflow: clip` cannot cut it off.
    expect(ring).toMatch(/outline-offset:\s*calc\(-1 \* var\(--focus-ring-width\)\)/);
  });

  it('★ a second control in the row stays above the overlay, and pressable', () => {
    const above = rule('.above');
    expect(above).toMatch(/position:\s*relative/);
    expect(above).toMatch(/z-index:\s*1\b/);
  });

  it('⚠ a control whose popup is open rises over the next row’s control', () => {
    expect(rule(".above:has([aria-expanded='true'])")).toMatch(/z-index:\s*2\b/);
  });
});
