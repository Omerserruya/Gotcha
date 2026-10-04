import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * ★★ A 401 in a server action is sign-in, never "that didn't go through"
 * (Omer, 2026-10-04). One helper, and this test: every catch in a
 * `'use server'` file must call it before anything else, so a catch added
 * tomorrow cannot quietly turn a signed-out session into a failed write.
 *
 * Blind spot, named: a promise's `.catch(cb)` is not walked — no action file
 * uses one today (the `.catch(` there are zod's).
 */
const ROOT = join(process.cwd(), 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
const actionFiles = files(ROOT).filter((path) =>
  /^'use server';/m.test(readFileSync(path, 'utf8')),
);

/** Each `catch (x) {` whose next statement is not `await signInIfSignedOut(x);`. */
export function catchesSkippingSignIn(source: string): number[] {
  const lines = source.split('\n');
  const missed: number[] = [];
  lines.forEach((line, i) => {
    const m = /\bcatch\s*(?:\((\w+)[^)]*\))?\s*\{/.exec(line);
    if (!m) return;
    const next = lines.slice(i + 1).find((l) => l.trim() && !l.trim().startsWith('//'));
    if (!m[1] || !next?.includes(`await signInIfSignedOut(${m[1]});`)) missed.push(i + 1);
  });
  return missed;
}

describe('★★ every catch in a server action sends a signed-out session to sign-in', () => {
  it('the walk finds the action files (it is not passing on an empty list)', () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(20);
  });

  it.each(actionFiles.map((path) => [path.slice(ROOT.length + 1)]))('%s', (path) => {
    expect(catchesSkippingSignIn(readFileSync(join(ROOT, path), 'utf8'))).toEqual([]);
  });

  it('★ the check catches the shapes it must — run against them', () => {
    expect(catchesSkippingSignIn('try { a(); } catch (cause) {\n  return failed;\n}')).toEqual([1]);
    expect(catchesSkippingSignIn('try { a(); } catch {\n  return failed;\n}')).toEqual([1]);
    expect(
      catchesSkippingSignIn(
        'try {} catch (cause: unknown) {\n  // why\n  await signInIfSignedOut(cause);\n}',
      ),
    ).toEqual([]);
    expect(catchesSkippingSignIn('} catch (err) {\n  await signInIfSignedOut(cause);\n')).toEqual([
      1,
    ]);
  });
});

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
);
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-gotcha-return-to': '/en/approvals' }),
}));

describe('★★ signInIfSignedOut', () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it('a 401: to sign-in, with the way back', async () => {
    const { signInIfSignedOut } = await import('@/api/client/signed-out');
    await expect(
      signInIfSignedOut(new ApiError({ kind: 'authentication', status: 401 })),
    ).rejects.toThrow(`REDIRECT /api/auth/login?returnTo=${encodeURIComponent('/en/approvals')}`);
  });

  it.each([
    [403, 'authorization'],
    [500, 'server'],
    [409, 'conflict'],
  ] as const)('a %i is not signed out: nothing happens', async (status, kind) => {
    const { signInIfSignedOut } = await import('@/api/client/signed-out');
    await signInIfSignedOut(new ApiError({ kind, status }));
    await signInIfSignedOut(new Error('not an api error'));
    expect(redirect).not.toHaveBeenCalled();
  });
});
