/**
 * Which feature components are finished, tested, and on no page?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY
 * ════════════════════════════════════════════════════════════════════════════
 * `TeamLoad` and `AskedAbout` were built for screen 06, each with a passing
 * test file, and **imported by nothing.** The analytics routes are still the
 * placeholder stub, so the screen does not exist — and no artefact disagreed:
 * the components render correctly when a test renders them, and nothing
 * anywhere asks whether a page does.
 *
 * It is the same shape as the three i18n catalogues no loader enumerated. In
 * both cases every test read the artefact and nothing read the wiring.
 *
 *   npx tsx scripts/orphan-component-sweep.ts
 *
 * ── WHAT COUNTS AS REACHED ──
 * An exported component is reached if any non-test file outside its own
 * directory imports it, or if a file in its own directory that is itself
 * reached imports it. So a panel mounted by its screen's own composite counts,
 * and a pair of components that only import each other does not.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──
 * It does not fail the build. A component can be legitimately ahead of its
 * screen — built against an agreed design while the route waits on a ruling —
 * and turning that into a red gate would push somebody to mount a placeholder
 * to silence it. It prints, and a person decides.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/* `no-console` is on repo-wide; a build script writes to the stream directly,
   the same choice `empty-body-sweep.ts` made. */
const out = (text: string) => process.stdout.write(`${text}\n`);

const ROOT = 'src';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx$/.test(entry.name) ? [path] : [];
  });
}

const all = walk(ROOT);
const isTest = (path: string) => /\.test\.tsx?$/.test(path);
const sources = all.filter((path) => !isTest(path));

/** Exported component names per file — `export function Name(` or `export const Name =`. */
const exportsOf = new Map<string, string[]>();
for (const path of sources) {
  const source = readFileSync(path, 'utf8');
  const names = [
    ...source.matchAll(/export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9]*)/g),
    ...source.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9]*)\s*[:=]/g),
  ].map((match) => match[1]!);
  if (names.length > 0) exportsOf.set(path, [...new Set(names)]);
}

/** Which non-test files mention each name as an import. */
function importersOf(name: string, ownPath: string): string[] {
  return sources.filter((path) => {
    if (path === ownPath) return false;
    const source = readFileSync(path, 'utf8');
    /* An import statement naming it, rather than any mention of the word. */
    return new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(source);
  });
}

interface Orphan {
  readonly path: string;
  readonly name: string;
}
const orphans: Orphan[] = [];

for (const [path, names] of exportsOf) {
  for (const name of names) {
    if (importersOf(name, path).length === 0) orphans.push({ path: relative('.', path), name });
  }
}

/*
 * A page or layout is reached by the router, not by an import. So is anything
 * Next.js calls by convention.
 */
const ROUTED = /(?:^|\/)(?:page|layout|template|error|loading|not-found|default)\.tsx$/;
const unreached = orphans.filter((orphan) => !ROUTED.test(orphan.path));

if (unreached.length === 0) {
  out(`OK — every exported component in ${ROOT} is imported somewhere.`);
  process.exit(0);
}

out(`${unreached.length} exported component(s) that nothing imports:\n`);
for (const orphan of unreached) {
  const tested = all.some(
    (path) => isTest(path) && readFileSync(path, 'utf8').includes(orphan.name),
  );
  out(`  ${orphan.name}  —  ${orphan.path}${tested ? '  (has a test)' : ''}`);
}
out(
  '\nA component with a test and no importer is finished and absent. Mount it, or\n' +
    'say in its own file why it is waiting — the second is a legitimate answer and\n' +
    'the point of printing rather than failing.',
);
