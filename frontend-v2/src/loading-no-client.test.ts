import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ A `loading.tsx` RENDERS NO CLIENT COMPONENT (dev, 2026-11-04).
 *
 * Next 16.3.4 writes a loading segment's client chunks as `<script async src>`
 * with no CSP nonce (create-component-styles-and-scripts.js), and our policy's
 * `'strict-dynamic'` refuses them. A refused tag is not only a lost script:
 * Turbopack's chunk loader, finding a `script[src]` for a chunk already in the
 * page, waits on that tag's `error` event instead of loading the chunk again,
 * and a refused tag has already fired it. So a page that needs that chunk later
 * never renders, and the loading boundary above it stays forever. On the phone,
 * the customer screen opened from a conversation sat on the thread's skeleton
 * (ticket-csp-loading-nonce.md).
 *
 * This walks each `loading.tsx`'s import graph (src files through `@/` and
 * relative imports, plus packages) and fails on any `'use client'` module or
 * any package not known to be server-safe.
 *
 * Blind spots, named:
 * - It reads import statements with a regex; a dynamic `import()` is not walked.
 * - Packages are judged by the lists below, not by reading their files.
 *   `lucide-react` is on the client list: 1.38's Icon is `'use client'`.
 */
const SRC = join(process.cwd(), 'src');
const APP = join(SRC, 'app');

/** Packages whose modules are server-safe in a loading file. Anything else fails. */
const SERVER_PACKAGES = new Set([
  'react',
  'next-intl',
  'next-intl/server',
  'clsx',
  'zod',
  'server-only',
  'next/headers',
]);

/**
 * Loading files that still render client components, each with its reason.
 * Desktop only; none may be added under `(mobile)`. Each is open on
 * ticket-csp-loading-nonce.md (option 1, the Next nonce patch, fixes them all).
 */
const KNOWN: Record<string, string> = {
  'app/[locale]/(app)/customers/loading.tsx': 'The live search and Add in the skeleton (04).',
  'app/[locale]/(app)/inbox/loading.tsx': 'LoadingConversation is a client component.',
  'app/[locale]/(app)/studio/automations/loading.tsx': 'The list and its frame (CanSee, Link, icons).',
  'app/[locale]/(app)/studio/skills/loading.tsx': 'The library itself renders as its own skeleton.',
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return name === 'loading.tsx' ? [path] : [];
  });

/** The modules a file imports for their values (type-only imports are erased). */
export function valueImports(source: string): string[] {
  const specs: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(re)) {
    if (m[2]) continue;
    specs.push(m[3]!);
  }
  return specs;
}

function resolveFile(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : join(dirname(from), spec);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every reason this loading file emits a client chunk, as "chain: reason". */
export function clientReasons(entry: string): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const here = [...chain, relative(SRC, file)];
    if (/^\s*['"]use client['"]/.test(source)) {
      reasons.push(`${here.join(' > ')}: 'use client'`);
      return;
    }
    for (const spec of valueImports(source)) {
      if (/\.(css|png|svg|jpg|webp)$/.test(spec)) continue;
      if (spec.startsWith('@/') || spec.startsWith('.')) {
        const next = resolveFile(spec, file);
        if (next === null) reasons.push(`${here.join(' > ')}: cannot resolve ${spec}`);
        else visit(next, here);
      } else if (!SERVER_PACKAGES.has(spec)) {
        reasons.push(`${here.join(' > ')}: package ${spec}`);
      }
    }
  };
  visit(entry, []);
  return reasons;
}

describe('a loading.tsx renders no client component', () => {
  const entries = walk(APP);

  it('finds the loading files, the phone ones among them', () => {
    expect(entries.filter((path) => path.includes('(mobile)')).length).toBeGreaterThanOrEqual(11);
  });

  it.each(entries.map((path) => [relative(SRC, path)]))('%s', (name) => {
    const reasons = clientReasons(join(SRC, name));
    if (name in KNOWN) {
      expect(name.includes('(mobile)'), 'a phone loading file cannot be an exception').toBe(false);
      expect(reasons.length, `${name} is listed as an exception but has no client import`).toBeGreaterThan(0);
      return;
    }
    expect(reasons).toEqual([]);
  });
});

describe('valueImports', () => {
  it('reads value imports and skips type-only ones', () => {
    const source = [
      "import { a } from '@/x';",
      "import type { B } from '@/y';",
      "import styles from './s.module.css';",
      "export { c } from './z';",
      "import 'side-effect';",
    ].join('\n');
    expect(valueImports(source)).toEqual(['@/x', './s.module.css', './z', 'side-effect']);
  });
});
