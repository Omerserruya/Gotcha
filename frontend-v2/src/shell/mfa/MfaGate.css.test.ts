import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★ The gate is exactly one screen and the frame takes what is left (dev
 * walk of 8fafcfe2: on an iPhone 13 at 390x664 the footer sat below the
 * fold; on desktop a fixed 540px frame opened Authentik's page scrolled).
 * Measured in Chromium (2026-11-09): no page scroll at 390x664, 360x560,
 * 1280x720 or 1440x900, footer inside every one; the frame 382 to 648px.
 * jsdom has no layout, so this holds the rules that measurement rests on.
 */
const css = readFileSync(join(__dirname, 'MfaGate.module.css'), 'utf8');
const rule = (selector: string) => {
  const at = css.indexOf(`  ${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

describe('★ one screen, the footer always on it', () => {
  it('the gate is the viewport’s height, not at least it', () => {
    expect(rule('.gate')).toContain('block-size: 100dvh;');
    expect(rule('.gate')).not.toContain('min-block-size');
  });

  it('the card may shrink; the frame’s box fills what is left and may shrink to nothing', () => {
    expect(rule('.card')).toMatch(/flex: 0 1 \d+px;/);
    expect(rule('.card')).toContain('min-block-size: 0;');
    expect(rule('.flow')).toContain('flex: 1 1 auto;');
    expect(rule('.flow')).toContain('min-block-size: 0;');
    expect(rule('.frame')).toContain('block-size: 100%;');
  });

  it('the header, the footer and the mark never shrink', () => {
    for (const selector of ['.head', '.foot', '.brand']) {
      expect(rule(selector), selector).toContain('flex: none;');
    }
  });
});
