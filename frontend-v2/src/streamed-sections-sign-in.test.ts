import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ Every async component streamed inside a `<Suspense>` asks, after its
 * reads, whether the platform refused the session during this render - and
 * draws `SessionEnded` (sign-in, "Your session ended") instead of "couldn't
 * read". A loader cannot redirect: it catches its failure and returns
 * "unread", which swallows a redirect too.
 *
 * ★ Granularity: by source text. The children of each `<Suspense>` in `src`
 *   are read by name, and each name's `async function` definition must call
 *   `sessionRejected()`. A section rendered through a variable, or a sync
 *   wrapper around an async one, is not seen.
 */
const SRC = join(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The component names among a `<Suspense>`'s children (its fallback skipped). */
export function streamedNames(source: string): string[] {
  const names: string[] = [];
  let at = 0;
  for (;;) {
    const open = source.indexOf('<Suspense', at);
    if (open < 0) return names;
    // A mention in prose (`<Suspense>`, in a comment) is not a boundary.
    if (source[open - 1] === '`') {
      at = open + 1;
      continue;
    }
    // The opening tag ends at the first `>` outside braces.
    let depth = 0;
    let i = open + '<Suspense'.length;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    const close = source.indexOf('</Suspense>', i);
    if (close < 0) return names;
    const children = source.slice(i + 1, close);
    for (const m of children.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) names.push(m[1]!);
    at = close + 1;
  }
}

const sources = files(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('★★ a streamed section signed out is sign-in, not "couldn\'t read"', () => {
  const streamed = [...new Set(sources.flatMap((f) => streamedNames(f.text)))];
  const asyncDefs = new Map<string, string>();
  for (const f of sources) {
    for (const m of f.text.matchAll(/export async function ([A-Z][A-Za-z0-9]*)\(/g)) {
      const start = m.index!;
      const next = f.text.indexOf('\nexport ', start + 1);
      asyncDefs.set(m[1]!, f.text.slice(start, next < 0 ? undefined : next));
    }
  }
  const sections = streamed.filter((name) => asyncDefs.has(name));

  it('the walk finds the streamed sections (it is not passing on an empty list)', () => {
    expect(sections).toEqual(
      expect.arrayContaining([
        'ListSection',
        'LibrarySection',
        'ConversationStream',
        'OrdersChip',
        'CopilotWall',
      ]),
    );
  });

  it.each(sections)('%s asks sessionRejected()', (name) => {
    expect(asyncDefs.get(name)).toContain('sessionRejected()');
  });

  it('the reader skips a fallback and reads the children', () => {
    expect(
      streamedNames(
        '<Suspense key={x} fallback={<Skeleton a={{ b: 1 }} />}><Section /></Suspense>',
      ),
    ).toEqual(['Section']);
  });

  it('a mention in prose is not a boundary (it read a whole page as children once)', () => {
    expect(
      streamedNames(
        '/* inside `<Suspense>` */ <Other /> <Suspense fallback={null}><A /></Suspense>',
      ),
    ).toEqual(['A']);
  });
});
