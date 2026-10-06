import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ 02 TRACKS EVERY 600 HEADING AND FIGURE FROM 17px UP - HELD HERE.
 *
 * Measured over 02's source, the step for each size (the majority at each):
 * 17-25 −0.02em · 26 −0.025em · 27-28 −0.028em · 29-40 −0.03em · 42 −0.035em ·
 * 44-52 −0.04em. Fixed one size at a time it kept coming back: 26px titles,
 * then 25px figures, then five more sizes in one inventory. This is the rule
 * instead of the instances.
 *
 * ── THE SWEEP'S GRANULARITY, AND ITS BLIND SPOT ──
 * By RULE BLOCK in every `*.module.css`: a block that sets weight 600 and a
 * size of 17px or more (a px literal or a `--font-size-*` token) must set the
 * size's step. It cannot see a size and a weight set in two different rules
 * that meet on one element, nor a weight inherited from a parent.
 */

const ROOT = join(process.cwd(), 'src');

const tokens = readFileSync(join(ROOT, 'design-system/tokens/tokens.css'), 'utf8');
const tokenValue = (name: string): string | null =>
  tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim() ?? null;

/** The step 02 uses at this size, in em. */
export function stepFor(px: number): number {
  if (px <= 25) return -0.02;
  if (px === 26) return -0.025;
  if (px <= 28) return -0.028;
  // 02's one 36px heading ("Shell - the product lives inside one dark frame").
  if (px === 36) return -0.025;
  if (px <= 40) return -0.03;
  if (px <= 42) return -0.035;
  return -0.04;
}

/** Deliberate exceptions, each with 02's own reason. */
const EXCEPTIONS: Record<string, string> = {
  // 04b's disc: "DC" at 20px/600, untracked in 02 - initials are not a heading.
  'features/customers/Customers.module.css .cardDisc': 'initials',
  // A code's digit boxes: 02's 26px digit tiles are its only untracked 26s.
  'features/auth/SecondFactor.module.css .box': 'digit tiles',
  // 09's automation name: 02's only 24px heading, at −0.025em (`ls:-0.6px`).
  'features/automations/Automations.module.css .name': '09 heading',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith('.module.css') ? [path] : [];
  });
}

const px = (value: string | undefined): number | null => {
  if (!value) return null;
  const literal = value.match(/^([\d.]+)px$/);
  if (literal) return Number(literal[1]);
  const token = value.match(/^var\(--(font-size-[\w-]+)\)$/);
  return token ? px(tokenValue(token[1]!) ?? undefined) : null;
};

const em = (value: string | undefined): number | null => {
  if (!value) return null;
  const literal = value.match(/^(-?[\d.]+)em$/);
  if (literal) return Number(literal[1]);
  const token = value.match(/^var\(--(letter-spacing-[\w-]+)\)$/);
  return token ? em(tokenValue(token[1]!) ?? undefined) : null;
};

export function offenders(): string[] {
  const found: string[] = [];
  for (const file of files(ROOT)) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = block[1]!.trim();
      const body = block[2]!;
      const prop = (name: string) =>
        body.match(new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`))?.[1]?.trim();
      const weight = prop('font-weight');
      if (weight !== '600' && weight !== 'var(--font-weight-semibold)') continue;
      const size = px(prop('font-size'));
      if (size === null || size < 17) continue;
      const where = `${file.slice(ROOT.length + 1)} ${selector}`;
      if (where in EXCEPTIONS) continue;
      const tracking = em(prop('letter-spacing'));
      if (tracking !== stepFor(size)) {
        found.push(`${where} - ${size}px, tracking ${prop('letter-spacing') ?? 'none'}`);
      }
    }
  }
  return found;
}

describe('★★ every 600 style from 17px up carries 02’s step for its size', () => {
  it('no rule is missing it, or has another size’s', () => {
    expect(offenders()).toEqual([]);
  });

  it('the steps, as measured', () => {
    expect([17, 22, 24, 25, 26, 27, 30, 34, 36, 40, 42, 52].map(stepFor)).toEqual([
      -0.02, -0.02, -0.02, -0.02, -0.025, -0.028, -0.03, -0.03, -0.025, -0.03, -0.035, -0.04,
    ]);
  });
});
