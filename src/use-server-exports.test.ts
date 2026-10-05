import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A 'use server' FILE MAY EXPORT ONLY ASYNC FUNCTIONS — AND VITEST IGNORES IT
 * ════════════════════════════════════════════════════════════════════════════
 * Next refuses the whole module at runtime when a server-action file exports
 * anything else: "A "use server" file can only export async functions, found
 * object." `approvals/actions.ts` exported `EDIT_REFUSALS`, and approve,
 * reject and edit ALL answered 500 on dev while every test passed — vitest
 * reads the directive as a string and moves on.
 *
 * So this reads every 'use server' file and allows, at the top level, only:
 * `export async function`, `export default async function`, and type-only
 * exports (`export type`, `export interface`). Anything else — a const, a
 * plain function, a re-export list — fails here, before it fails a merchant.
 */

const ROOT = join(__dirname);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesUnder(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const ALLOWED = [
  /^export\s+async\s+function\b/,
  /^export\s+default\s+async\s+function\b/,
  /^export\s+type\b/,
  /^export\s+interface\b/,
];

/** Top-level `export …` lines a server-action module may not have. */
export function badExports(source: string): string[] {
  const directive = source.trimStart().match(/^(['"])use server\1/);
  if (!directive) return [];
  return source
    .split('\n')
    .filter((line) => /^export\b/.test(line))
    .filter((line) => !ALLOWED.some((ok) => ok.test(line)))
    .map((line) => line.trim());
}

describe('★★ every server-action file exports only async functions (and types)', () => {
  const serverFiles = filesUnder(ROOT).filter((path) =>
    /^(['"])use server\1/.test(readFileSync(path, 'utf8').trimStart()),
  );

  it('there are server-action files to check (the scan is not looking at nothing)', () => {
    expect(serverFiles.length).toBeGreaterThan(10);
  });

  it.each(serverFiles.map((path) => [path.slice(ROOT.length + 1), path]))('%s', (_, path) => {
    expect(badExports(readFileSync(path, 'utf8'))).toEqual([]);
  });
});

describe('the check itself — run against the defect it is for', () => {
  it('★ catches the exact export that broke approvals', () => {
    const broken =
      "'use server';\n\nexport async function a() {}\nexport const EDIT_REFUSALS = ['x'] as const;\n";
    expect(badExports(broken)).toEqual(["export const EDIT_REFUSALS = ['x'] as const;"]);
  });

  it('catches a plain function and a re-export list too', () => {
    expect(
      badExports("'use server';\nexport function f() {}\nexport { g } from './g';\n"),
    ).toHaveLength(2);
  });

  it('allows async functions and types; ignores files without the directive', () => {
    expect(
      badExports(
        "'use server';\nexport async function a() {}\nexport type T = 1;\nexport interface I {}\n",
      ),
    ).toEqual([]);
    expect(badExports('export const fine = 1;\n')).toEqual([]);
  });
});
