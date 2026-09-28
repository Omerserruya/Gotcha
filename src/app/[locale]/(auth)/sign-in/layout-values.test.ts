import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Numbers on screen 00a that came from the design rather than from taste.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A LITERAL IN A STYLESHEET HAS NOTHING BEHIND IT
 * ════════════════════════════════════════════════════════════════════════════
 * The editorial panel was 460px where the design says 508px — 48px narrow,
 * on the screen's largest element, and nothing in the repository disagreed.
 * Omer read it off the screen; no artefact could have.
 *
 * These assert the handful of 00a values that are quoted from
 * `Directions.dc.html`, so that changing one is a decision somebody makes
 * rather than a drift nobody sees. Same reason the tick count is asserted
 * against the number of figures and the matcher is read from its source.
 *
 * ★ Deliberately only the QUOTED ones. A test that pinned every declaration
 *   would redden on every legitimate edit and be deleted within a week.
 */

const css = readFileSync('src/app/[locale]/(auth)/sign-in/SignIn.module.css', 'utf8');

const declaration = (selector: string, property: string): string | undefined => {
  const block = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  return new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;]+)`).exec(block ?? '')?.[1]?.trim();
};

describe('⚠⚠ 00a values quoted from the design', () => {
  it('⚠⚠ the editorial panel is the design’s 508px, not 460', () => {
    // `width:508px;flex:none` on the dark column, in the mock's own markup.
    expect(declaration('editorial', 'inline-size')).toBe('508px');
  });

  it('★ and it does not flex, or the ratio stops being the design’s', () => {
    // `flex:none` there and `flex:1` on the work surface: the dark column is
    // fixed and the form takes the remainder. A flexible panel would be a
    // different screen at every viewport.
    expect(declaration('editorial', 'flex')).toBe('none');
  });

  it('★★ the rotating figures share one box, so it cannot resize as copy changes', () => {
    /*
     * `position: relative` with a fixed block-size is what lets three
     * absolutely-positioned statements of different lengths cross-fade in
     * place. Lose either and the panel jumps on every transition — which is
     * the kind of thing that reads as "the animation is broken".
     */
    expect(declaration('editorialStage', 'position')).toBe('relative');
    expect(declaration('editorialStage', 'block-size')).toBe('250px');
  });

  it('⚠⚠ the ticks are spaced at the design’s 5px, not at a token that was nearby', () => {
    /*
     * `gap:5px` in the mock. The scale has 4 and 6 and no 5, and my first
     * version used `--space-8` — three pixels wider, invented, and nothing
     * could have disagreed with it. A literal with the design's number beats a
     * token chosen for proximity.
     */
    expect(declaration('editorialTicks', 'gap')).toBe('5px');
  });

  it('★ and the rule between marker and status is the design’s 1×12', () => {
    expect(declaration('editorialRule', 'inline-size')).toBe('1px');
    expect(declaration('editorialRule', 'block-size')).toBe('12px');
  });

  it('★★ the ticks are the design’s 16×3, on the same 15s cycle as the figures', () => {
    /*
     * `width:16px;height:3px;border-radius:2px;opacity:.26` and
     * `gotchaDot 15s ease-in-out infinite`. The shared 15s is the load-bearing
     * part: ticks and figures must be on one clock or they drift apart.
     */
    expect(declaration('editorialTick', 'inline-size')).toBe('16px');
    expect(declaration('editorialTick', 'block-size')).toBe('3px');
    expect(declaration('editorialTick', 'animation')).toContain('15s');
    expect(declaration('editorialSlide', 'animation')).toContain('15s');
  });
});
