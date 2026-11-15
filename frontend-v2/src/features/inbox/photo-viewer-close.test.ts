import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The phone photo viewer's X sits over the photo itself. It must read over
 * any photo, so the contrast is computed from the tokens and the rule as
 * written, over the two extremes: a white photo and a black one.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const inbox = strip(readFileSync('src/features/inbox/Inbox.module.css', 'utf8'));
const tokens = strip(readFileSync('src/design-system/tokens/tokens.css', 'utf8'));

const rule = /\.photoViewerClose\s*\{([^}]*)\}/.exec(inbox)?.[1] ?? '';
type Rgb = readonly [number, number, number];
const hex = (name: string): Rgb => {
  const value = new RegExp(`--${name}:\\s*#([0-9a-f]{6});`, 'i').exec(tokens)?.[1];
  if (!value) throw new Error(`no --${name} in tokens.css`);
  const at = (i: number) => parseInt(value.slice(i, i + 2), 16);
  return [at(0), at(2), at(4)];
};
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const mix =
  /background-color:\s*color-mix\(in srgb,\s*var\(--([a-z-]+)\)\s*(\d+)%,\s*transparent\)/.exec(
    rule,
  );
const glyph = /(?:^|;)\s*color:\s*var\(--([a-z-]+)\)/.exec(rule)?.[1];

const disc = (photo: Rgb): Rgb => {
  const [, token, percent] = mix ?? [];
  if (!token || !percent) throw new Error('.photoViewerClose has no color-mix background');
  const [r, g, b] = hex(token);
  const p = Number(percent) / 100;
  const over = (c: number, under: number) => p * c + (1 - p) * under;
  return [over(r, photo[0]), over(g, photo[1]), over(b, photo[2])];
};

describe('★ the photo viewer X reads over any photo', () => {
  const WHITE: Rgb = [255, 255, 255];
  const BLACK: Rgb = [0, 0, 0];

  it.each([
    ['a white photo', WHITE],
    ['a black photo', BLACK],
  ] as const)('over %s the X is at least 4.5:1 on its disc', (_name, photo) => {
    if (!glyph) throw new Error('.photoViewerClose has no var() colour');
    expect(contrast(hex(glyph), disc(photo))).toBeGreaterThanOrEqual(4.5);
  });

  it('over a white photo the disc itself stands off the photo at 3:1 or more', () => {
    expect(contrast(disc(WHITE), WHITE)).toBeGreaterThanOrEqual(3);
  });

  it('a ring and a shadow draw its edge where the disc meets a photo of its own colour', () => {
    expect(rule).toMatch(/box-shadow:\s*0 0 0 1px color-mix\(in srgb, var\(--mobile-ink-text\)/);
    expect(rule).toMatch(/,\s*0 2px 8px color-mix\(in srgb, var\(--mobile-ink\)/);
  });
});
