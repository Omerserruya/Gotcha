import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ★★ NO LINK THAT IS ON SCREEN ALL THE TIME MAY PREFETCH (prod, 2026-11-18).
 *
 * A prefetched page is a server render, and every router.refresh() throws the
 * router's cache away, so each visible prefetching link asks for its page
 * again. The live inbox refreshes on every message: on a busy inbox the eight
 * primary nav links and the open customer were asked for every 3 s, about
 * 3,500 requests in 15 minutes from one tab, and the platform refused the
 * account's calls.
 *
 * So every `<Link>` in the shell (desktop and phone) and in the inbox, the
 * page that refreshes most, says `prefetch={false}`. A click still navigates.
 * This reads every file under those folders, so a new one is covered the day
 * it is added.
 */
const ROOTS = ['src/shell', 'src/features/inbox'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** Each `<Link ...>` opening tag, braces balanced, so `{a > b}` does not end it. */
export function linkTags(source: string): string[] {
  const tags: string[] = [];
  const start = /<Link\b/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(source)) !== null) {
    let depth = 0;
    let end = match.index;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0 && source[end - 1] !== '=') break;
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

describe('★★ shell and inbox links never prefetch', () => {
  const files = ROOTS.flatMap((root) => sources(join(process.cwd(), root)));

  it('there are files to read, and links in them', () => {
    expect(files.length).toBeGreaterThan(40);
    const links = files.flatMap((file) => linkTags(readFileSync(file, 'utf8')));
    expect(links.length).toBeGreaterThan(20);
  });

  it('★★ every <Link> says prefetch={false}', () => {
    const offenders = files.flatMap((file) =>
      linkTags(readFileSync(file, 'utf8'))
        .filter((tag) => !/\bprefetch=\{false\}/.test(tag))
        .map((tag) => `${relative(process.cwd(), file)}: ${tag.slice(0, 80).replace(/\s+/g, ' ')}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the reader sees a prefetching link, and one with a brace inside', () => {
    expect(linkTags('<Link href="/a">x</Link>')).toEqual(['<Link href="/a">']);
    expect(linkTags('<Link href={a > b ? "/a" : "/b"} prefetch={false}>')).toEqual([
      '<Link href={a > b ? "/a" : "/b"} prefetch={false}>',
    ]);
    expect(linkTags('<LinkButton href="/a">')).toEqual([]);
  });

  it.each([
    'src/shell/PrimaryNavigation.tsx',
    'src/shell/mobile/MobileTabs.tsx',
    'src/features/inbox/wall/CopilotWall.tsx',
  ])('%s is read, and has links', (file) => {
    expect(files.map((f) => relative(process.cwd(), f))).toContain(file);
    expect(linkTags(readFileSync(join(process.cwd(), file), 'utf8')).length).toBeGreaterThan(0);
  });
});
