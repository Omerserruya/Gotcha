import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ The signed-out pages must render per request: the CSP's script nonce is
 * applied at render time, and a prerendered page carries none, so every
 * script is refused and nothing hydrates (dev, 2026-11-14: the request form
 * fell back to a native GET with the address in the URL). jsdom cannot see
 * that, so this pins the cause: each page reads the request - its
 * `searchParams`, or `connection()`.
 */
const HERE = 'src/app/[locale]/(auth)/account-deletion';
const PAGES = ['page.tsx', 'confirm/page.tsx'];

describe('★★ the account-deletion pages are never prerendered', () => {
  it.each(PAGES)('%s reads the request', (file) => {
    const source = readFileSync(join(HERE, file), 'utf8');
    expect(source.includes('await connection()') || /await searchParams\b/.test(source)).toBe(true);
  });

  it('★ the request page, which has no query to read, calls connection() itself', () => {
    const source = readFileSync(join(HERE, 'page.tsx'), 'utf8');
    expect(source).toMatch(/import \{ connection \} from 'next\/server';/);
    expect(source).toMatch(/\n  await connection\(\);\n/);
  });
});
