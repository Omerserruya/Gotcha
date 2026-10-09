#!/usr/bin/env node
/**
 * Every `var(--x)` in `src/` names a custom property that is actually defined.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ WHY THIS EXISTS: AN UNDEFINED CUSTOM PROPERTY FAILS IN SILENCE
 * ════════════════════════════════════════════════════════════════════════════
 * `font-style: var(--font-serif-style)` where nothing defines that name is an
 * INVALID declaration. The browser drops it, `stylelint` says nothing, and the
 * property keeps its inherited or initial value. There is no warning anywhere.
 *
 * It has cost this project twice in one day:
 *
 *   --font-serif-style   declared only inside `:root:lang(he)`, so Latin had
 *                        no value and the display serif was upright on every
 *                        screen since it shipped
 *   --text-danger        never declared at all; caught by hand, in a file
 *                        written six hours after the first was fixed
 *
 * ★ Knowing the class does not protect you from it. This does, and it is the
 *   only one of the day's defects a machine can catch outright — the others
 *   need a reader who asks what a rule's scope actually is.
 *
 * ⚠ IT CHECKS DEFINITION, NOT REACHABILITY. `--font-serif-style` would have
 *   PASSED this: it was defined, just not in a block Latin could see. A
 *   cascade-aware check is a different and much larger tool. This catches the
 *   name that exists nowhere, which is the cheaper half — and which is exactly
 *   what `--text-danger` was.
 *
 * ⚠ AND ITS OWN BLIND SPOT IS NAMED BELOW: definitions written in TypeScript.
 *   The first version reported six false positives for precisely that reason.
 */
import { globSync, readFileSync } from 'node:fs';

const files = globSync('src/**/*.css');

/* Anything of the form `--name:` in a declaration position defines a name. */
const defined = new Set();
for (const file of files) {
  const css = readFileSync(file, 'utf8');
  for (const [, name] of css.matchAll(/(?:^|[;{]|\n)\s*(--[a-zA-Z0-9-]+)\s*:/g)) {
    defined.add(name);
  }
}

/*
 * ═════════════════════════════════════════════════════════════════════
 * ⚠⚠ NOT EVERY DEFINITION IS IN A STYLESHEET, AND THE FIRST VERSION MISSED SIX
 * ═════════════════════════════════════════════════════════════════════
 * Scanning only CSS reported five `next/font` families and `--brand-mark` as
 * undefined. All six are real, defined from TypeScript — `Archivo({ variable:
 * '--font-archivo' })` emits the property onto a class, and `Logo.tsx` sets
 * `--brand-mark` in an inline style.
 *
 * ★ Had the first version been believed, the "fix" would have been to declare
 *   five font variables in CSS and break `next/font`. A sweep has a
 *   granularity, and this one's was the file extension.
 */
for (const file of globSync('src/**/*.{ts,tsx}')) {
  const source = readFileSync(file, 'utf8');
  for (const [, name] of source.matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]/g)) {
    defined.add(name);
  }
}

const problems = [];
for (const file of files) {
  const css = readFileSync(file, 'utf8');
  const lines = css.split('\n');
  lines.forEach((line, index) => {
    for (const [, name] of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      /*
       * `var(--x, fallback)` is legitimate when the name is meant to be
       * absent, so a declaration with a fallback is not a defect.
       */
      const hasFallback = new RegExp(`var\\(\\s*${name}\\s*,`).test(line);
      if (!defined.has(name) && !hasFallback) {
        problems.push(`${file}:${index + 1}  ${name}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(
    `\n${problems.length} undefined custom ${problems.length === 1 ? 'property' : 'properties'}.` +
      `\nAn undefined one makes the whole declaration invalid, silently.\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`tokens: ${defined.size} defined, every var() in ${files.length} files resolves.`);
