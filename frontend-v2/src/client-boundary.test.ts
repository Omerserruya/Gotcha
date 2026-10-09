import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A module on the server may take only COMPONENTS and TYPES from a module
 * with `'use client'`.
 *
 * Anything else - a function, a constant - reaches the server as a client
 * reference, and calling it throws ("Attempted to call isAddWay() from the
 * server but isAddWay is on the client"). 08b's page did exactly that, and
 * its page test passed, because vitest ignores the directive. Only a build,
 * or this, sees it.
 *
 * "On the server" = not client-side, where client-side is a `'use client'`
 * module or one every importer of which is client-side (`send-media.ts`,
 * imported only by the Composer, runs in the browser).
 *
 * Granularity: by import statement, through `@/` and relative paths. A
 * component is a PascalCase name with a lower-case letter (`AddKnowledge`,
 * not `ADD_WAYS`). Blind spots: `export * from` re-exports, dynamic
 * `import()`, a default import (taken as a component), and a test file
 * importing a server module (tests are not scanned).
 */

const ROOT = resolve('src');
const COMPONENT = /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/;
const IMPORT = /import\s+(type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const isClient = (source: string) =>
  /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);

export function crossings(
  all: readonly string[],
  read: (path: string) => string,
  exists: (path: string) => boolean,
): string[] {
  const target = (from: string, spec: string) => {
    const base = spec.startsWith('@/')
      ? join(ROOT, spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(from), spec)
        : null;
    if (!base) return null;
    return (
      [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')].find(
        exists,
      ) ?? null
    );
  };
  const imports = new Map(
    all.map((path) => [
      path,
      [...read(path).matchAll(IMPORT)].map((m) => ({
        typeOnly: Boolean(m[1]),
        clause: m[2]!,
        to: target(path, m[3]!),
      })),
    ]),
  );
  const importers = new Map<string, string[]>();
  for (const [from, list] of imports) {
    for (const { to } of list) if (to) importers.set(to, [...(importers.get(to) ?? []), from]);
  }
  const clientSide = new Set(all.filter((path) => isClient(read(path))));
  for (let grew = true; grew;) {
    grew = false;
    for (const path of all) {
      const by = importers.get(path) ?? [];
      if (!clientSide.has(path) && by.length > 0 && by.every((p) => clientSide.has(p))) {
        clientSide.add(path);
        grew = true;
      }
    }
  }
  const client = new Set(all.filter((path) => isClient(read(path))));
  const found: string[] = [];
  for (const [path, list] of imports) {
    if (clientSide.has(path)) continue;
    for (const { typeOnly, clause, to } of list) {
      if (typeOnly || !to || !client.has(to)) continue;
      for (const raw of (/\{([^}]*)\}/.exec(clause)?.[1] ?? '').split(',')) {
        const spec = raw.trim();
        if (!spec || spec.startsWith('type ')) continue;
        const name = spec.split(/\s+as\s+/)[0]!.trim();
        if (!COMPONENT.test(name)) found.push(`${path.slice(ROOT.length + 1)} ← ${name}`);
      }
    }
  }
  return found;
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

describe('★ the server takes only components and types from a client module', () => {
  it('no server module imports a function or constant from a client module', () => {
    expect(crossings(files(ROOT), (p) => readFileSync(p, 'utf8'), isFile)).toEqual([]);
  });

  describe('★ against fixtures', () => {
    const page = join(ROOT, 'app/x/page.tsx');
    const dialog = join(ROOT, 'app/x/Dialog.tsx');
    const helper = join(ROOT, 'app/x/helper.ts');
    const run = (fake: Record<string, string>) =>
      crossings(
        Object.keys(fake),
        (p) => fake[p]!,
        (p) => p in fake,
      );
    const DIALOG = "'use client';\nexport const isWay = () => true;\nexport function Dialog() {}";

    it('catches 08b’s shape: a page calling a helper from its client dialog', () => {
      expect(
        run({
          [page]: "import { Dialog, isWay, type Way } from './Dialog';\nexport default 1;",
          [dialog]: DIALOG,
        }),
      ).toEqual(['app/x/page.tsx ← isWay']);
    });

    it('a module only client code imports may use client values', () => {
      expect(
        run({
          [dialog]: "'use client';\nimport { go } from './helper';",
          [helper]: "import { isWay } from './Dialog';\nexport const go = isWay;",
          [join(ROOT, 'app/x/Other.tsx')]: DIALOG,
        }),
      ).toEqual([]);
    });

    it('…but not once a server module imports it too', () => {
      expect(
        run({
          [page]: "import { go } from './helper';",
          [helper]: "import { isWay } from './Dialog';\nexport const go = isWay;",
          [dialog]: DIALOG,
        }),
      ).toEqual(['app/x/helper.ts ← isWay']);
    });
  });
});
