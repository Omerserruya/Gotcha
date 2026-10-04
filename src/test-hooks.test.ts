import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A hook must not RETURN a mock.
 *
 * `beforeEach(() => spy.mockReset())` returns the spy, and vitest runs a
 * function returned from `beforeEach` as that test's teardown — so the spy is
 * called bare after every test. A spy set to throw then fails a test whose
 * assertions all passed ("Error: down", at the line that built the error);
 * one that resolves records a call nobody made. It cost an hour on 05e's
 * call actions, and three more files had the same shape.
 *
 * Granularity: by line, in test files — a hook whose arrow body is an
 * expression ending in `.mockReset()`, `.mockClear()` or `.mockRestore()`.
 * Blind spot: other returned functions (any arrow body that yields one).
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    // This file names the shape in its own fixtures.
    return /\.test\.(ts|tsx)$/.test(name) && name !== 'test-hooks.test.ts' ? [path] : [];
  });
}

const RETURNS_A_MOCK =
  /\b(?:beforeEach|afterEach|beforeAll|afterAll)\(\s*\(\)\s*=>\s*[A-Za-z_$][\w$.]*\.mock(?:Reset|Clear|Restore)\(\)\s*\)/;

describe('★ no hook returns a mock', () => {
  it('in any test file', () => {
    const offenders = files('src').filter((path) =>
      RETURNS_A_MOCK.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    ['beforeEach(() => post.mockReset());', true],
    ['afterEach(() => calls.end.mockClear())', true],
    ['beforeEach(() => {\n  post.mockReset();\n});', false],
    ['beforeEach(() => vi.useFakeTimers())', false],
  ])('%s → %s', (source, flagged) => {
    expect(RETURNS_A_MOCK.test(source)).toBe(flagged);
  });
});
