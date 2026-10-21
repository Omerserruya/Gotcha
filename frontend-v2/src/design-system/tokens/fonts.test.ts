import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The fonts are served from this repo (2026-10-21): a production build under
 * QEMU cannot fetch them. What can break silently: a rule naming a file that
 * is not there (the face falls back to a system font, no error), a family the
 * tokens name with no face, and a later `next/font/google` import bringing the
 * build-time fetch back.
 */
const FONTS = join(__dirname, '../fonts');
const css = readFileSync(join(FONTS, 'fonts.css'), 'utf8');
const families = readFileSync(join(__dirname, 'font-families.css'), 'utf8');
const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map(([, body]) => ({
  family: /font-family: '?([^';]+?)'?;/.exec(body!)?.[1],
  file: /src: url\('\.\/([^']+)'\)/.exec(body!)?.[1],
  range: /unicode-range:\s*([^;]+);/.exec(body!)?.[1] ?? '',
}));

describe('★★ the fonts are the repo’s own', () => {
  it('every face names a woff2 that is here, and is not empty', () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const { file } of faces) {
      expect(file, 'a face with no local src').toMatch(/\.woff2$/);
      expect(existsSync(join(FONTS, file!)), file).toBe(true);
      expect(statSync(join(FONTS, file!)).size, file).toBeGreaterThan(1000);
    }
  });

  it('every family the tokens name has faces; the Hebrew ones cover Hebrew', () => {
    const named = [...families.matchAll(/--font-[a-z-]+: '?([^';]+?)'?;/g)].map(([, f]) => f);
    expect(named).toHaveLength(5);
    for (const family of named) {
      expect(
        faces.some((f) => f.family === family),
        family,
      ).toBe(true);
    }
    for (const family of ['Heebo', 'Frank Ruhl Libre']) {
      expect(
        faces.some((f) => f.family === family && f.range.includes('U+0590-05FF')),
        `${family} has no Hebrew face`,
      ).toBe(true);
    }
  });

  it('nothing loads a font from Google at build time', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.(ts|tsx|css)$/.test(name) ? [path] : [];
      });
    const offenders = walk(join(__dirname, '../..')).filter((path) =>
      /next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(
        readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
