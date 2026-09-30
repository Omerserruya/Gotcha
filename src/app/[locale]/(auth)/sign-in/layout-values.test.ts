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

/*
 * ⚠⚠ COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT TIDINESS.
 *   These comments QUOTE THE MOCK — `font-size:13.5px; line-height:1.65` —
 *   so a declaration regex run over the raw file finds the quotation before
 *   the rule. It read 1.65 out of a comment and reported the file correct
 *   while the rule said something else.
 *
 * ★ Second time today a pattern matched its own explanatory prose: the sweep
 *   for `--size-code-box` found the comment recording its removal. A true
 *   match against the wrong object, in the instrument rather than the code.
 */
const css = readFileSync('src/app/[locale]/(auth)/sign-in/SignIn.module.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

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

describe('⚠⚠ the two that change what the reviewer sees', () => {
  it('⚠⚠ the supporting paragraph is the design’s 390px, not 340', () => {
    /*
     * `max-width:390px` in the mock. Ours was 340 — 13% narrower, on the
     * element "the left side with the changing sentences is too narrow" was
     * actually pointing at. The panel width was the other half of that
     * sentence and was fixed first.
     */
    expect(declaration('editorialSupport', 'max-inline-size')).toBe('390px');
  });

  it('⚠⚠ the display serif has a Latin default, or it falls back to upright', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A TOKEN DECLARED ONLY IN ITS EXCEPTION HAS NO RULE TO EXCEPT
     * ════════════════════════════════════════════════════════════════════════
     * `--font-serif-style` existed only inside `:root:lang(he)`, where
     * `normal` is correct and deliberate. In Latin the custom property was
     * undefined, so `font-style: var(--font-serif-style)` was an invalid
     * declaration — dropped in silence — and the largest text on the sign-in
     * screen has been upright since it shipped.
     *
     * Asserted in both directions: the base must be italic AND the Hebrew
     * override must survive, because "fixing" this by hard-coding italic in
     * the component would shear Hebrew letterforms and read as a rendering
     * fault.
     */
    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    const base = /:root\s*\{([\s\S]*?)\n  \}/.exec(tokens)?.[1] ?? '';
    expect(base, 'no base :root block found').toContain('--font-serif-style');
    expect(/--font-serif-style:\s*italic/.test(base)).toBe(true);

    const hebrew = /:root:lang\(he\)\s*\{([\s\S]*?)\n  \}/.exec(tokens)?.[1] ?? '';
    expect(hebrew, 'no :lang(he) block found').toContain('--font-serif-style');
    expect(/--font-serif-style:\s*normal/.test(hebrew)).toBe(true);
  });
});

describe('⚠⚠ the cluster: six values, all rounded the same direction', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * INDIVIDUALLY INVISIBLE, AND ALL SMALLER OR LIGHTER THAN DRAWN
   * ════════════════════════════════════════════════════════════════════════
   *     34px → 32   the editorial column's inline padding
   *     36px → 32   its footer row's top padding
   *     13.5 → 13   the supporting paragraph
   *     1.65 → 1.6  its line-height
   *   #6E6A63 → #8c887f  the eyebrow, on a DARK frame
   *   #2E2E2E → #333     the hairline
   *
   * ★ Not six small calls. A systematic drift in one direction, and the fix
   *   is on the scale rather than in this screen — 00b's editorial column is
   *   the same shell, and so is recovery's.
   *
   * ⚠ THREE OF THE SIX WERE ALREADY TOKENS NOTHING READ HERE:
   *   `--line-height-loose` was 1.65, `--frame-text-eyebrow` was #6e6a63, and
   *   `--frame-text-secondary` was #a29d95 and correct. The value existed and
   *   the call site did not use it — the third time today.
   */
  it('★★ the two spacing steps are the design’s own numbers', () => {
    expect(declaration('editorial', 'padding-inline')).toBe('var(--space-34)');
    expect(declaration('systemStatus', 'padding-block-start')).toBe('var(--space-36)');

    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    expect(tokens).toMatch(/--space-34:\s*34px/);
    expect(tokens).toMatch(/--space-36:\s*36px/);
  });

  it('⚠⚠ the supporting paragraph reads at the size and rhythm drawn', () => {
    expect(declaration('editorialSupport', 'font-size')).toBe('var(--font-size-editorial)');
    expect(declaration('editorialSupport', 'line-height')).toBe('var(--line-height-loose)');

    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    expect(tokens).toMatch(/--font-size-editorial:\s*13\.5px/);
    expect(tokens).toMatch(/--line-height-loose:\s*1\.65/);
  });

  it('⚠⚠ and `--font-size-body-sm` did NOT move, which is the point', () => {
    /*
     * Half a pixel is not a rounding error to fix in place. `body-sm` is read
     * by screens with nothing to do with this panel; changing it to suit one
     * role would move all of them to match a mock they are not drawn from.
     */
    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    expect(tokens).toMatch(/--font-size-body-sm:\s*13px/);
  });

  it('★★ the eyebrow uses the dark frame’s colour, by class not by position', () => {
    /*
     * `:first-child` would be a proxy for "the eyebrow" that holds only while
     * the eyebrow is first. This file has had enough of those today.
     */
    expect(declaration('editorialEyebrow', 'color')).toBe('var(--frame-text-eyebrow)');
    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    expect(tokens).toMatch(/--frame-text-eyebrow:\s*#6e6a63/i);
  });

  it('⚠ the hairline is the design’s #2e2e2e, on the token both readers share', () => {
    /*
     * `#333` appears nowhere in `Directions.dc.html`; `#2E2E2E` appears twice,
     * as the frame hairline on both 00a and 00b. Changed on the token because
     * the other reader — the shell's frame border — is the same hairline in
     * the same design language.
     */
    const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');
    expect(tokens).toMatch(/--frame-line:\s*#2e2e2e/i);
    expect(tokens).not.toMatch(/--frame-line:\s*#333\b/);
  });
});
