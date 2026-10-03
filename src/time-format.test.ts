import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every time the product writes is 24-hour, in every language: 02 writes
 * `09:12`. An `Intl` time option follows the LOCALE by default, so `en`
 * renders "9:12 AM" — on Security, on 07e and on Home's activity card it
 * did, and no screenshot test caught it because nothing reads the text.
 *
 * Granularity: by object literal. Any `{ … }` that gives `hour:` or
 * `timeStyle:` a string (an `Intl` option, not a schema's `hour: z.string()`)
 * must also say `hour12: false` or `hourCycle: 'h23'`. Blind
 * spots: options built in pieces (a spread, a variable), and a nested object
 * inside the literal.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

export function twelveHour(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found: string[] = [];
  for (const m of code.matchAll(/\{[^{}]*\b(?:hour|timeStyle)\s*:\s*['"][^{}]*\}/g)) {
    if (!/hour12\s*:\s*false|hourCycle\s*:\s*['"]h23['"]/.test(m[0])) {
      found.push(m[0].replace(/\s+/g, ' ').slice(0, 80));
    }
  }
  return found;
}

describe('★ every time is 24-hour', () => {
  it('no time option in src is left to the locale', () => {
    const offenders = files('src').flatMap((path) =>
      twelveHour(readFileSync(path, 'utf8')).map((hit) => `${path}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    ["{ timeStyle: 'short' }", 1],
    ["{ hour: '2-digit', minute: '2-digit' }", 1],
    ["{ hour: '2-digit',\n minute: '2-digit', // 24h\n hour12: false }", 0],
    ["{ timeStyle: 'short', hourCycle: 'h23' }", 0],
    ["{ day: 'numeric', month: 'short' }", 0],
    ['{ hour: z.string(), inbound: z.number() }', 0],
  ])('%s → %i', (source, count) => {
    expect(twelveHour(source)).toHaveLength(count);
  });
});
