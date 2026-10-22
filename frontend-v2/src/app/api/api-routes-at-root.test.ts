import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The app at the domain root (2026-10-21): every `/api/*` route here must be
 * on a path the gateway gives THIS app, never one it sends to a service.
 *
 * The gateway sends `/api/<prefix>` to the platform's services, and this app's
 * own server calls the platform through that same gateway (`API_BASE_URL`).
 * So a route named like a platform path either never reaches this app or, if
 * the gateway gives it here, makes this app call itself - which is what
 * `/api/realtime/ticket` would have done.
 *
 * What the gateway gives this app (Backend's nginx, agreed 2026-10-21):
 *   - exact: the three sign-in hops - the auth service's own copies are off
 *     (SESSION_COOKIE_CREATE=false), and this app's server calls only
 *     `/api/auth/me*` there;
 *   - prefixes no service owns: /api/bff/, /api/session/, /api/exports/.
 *
 * Granularity: by route directory (Next routes by directory, so a route file
 * this walk cannot see cannot be served either); the prefixes are checked
 * against both gateway templates' `location` lines, not against a live nginx.
 */
const API = join(__dirname);
const ROOT = join(__dirname, '../../../..');

const EXACT = new Set(['/api/auth/login', '/api/auth/callback', '/api/auth/logout']);
const OURS = ['/api/bff/', '/api/session/', '/api/exports/'];

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routes(path);
    return name === 'route.ts' ? [`/api/${relative(API, dir).split(sep).join('/')}`] : [];
  });
}

describe('★★ every API route is on a path the gateway gives this app at the root', () => {
  const found = routes(API);

  it('there are routes to check (the walk reads the real tree)', () => {
    expect(found).toEqual(expect.arrayContaining(['/api/auth/callback', '/api/session/ticket']));
  });

  it.each(found)('%s', (route) => {
    const ok = EXACT.has(route) || OURS.some((prefix) => `${route}/`.startsWith(prefix));
    expect(ok, `${route} is not on a path the gateway gives this app`).toBe(true);
  });

  it.each([
    ['dev', 'nginx/nginx.conf.template'],
    ['prod', 'gateway/nginx.prod.conf.template'],
  ])('no %s gateway location sends one of our prefixes to a service', (_, file) => {
    const conf = readFileSync(join(ROOT, file), 'utf8');
    for (const prefix of OURS) {
      const bare = prefix.slice(0, -1);
      // A location naming the prefix (or a shorter one covering it, like a bare `/api/s`).
      // Each location with its whole block (to the first closing brace): a
      // multi-line block that proxies to frontend_v2 is ours too.
      const lines = conf.split('\n');
      const blockOf = (i: number) => {
        const end = lines.findIndex((l, j) => j >= i && /}/.test(l));
        return lines.slice(i, end < 0 ? i + 1 : end + 1).join('\n');
      };
      const taken = lines
        .map((line, i) => ({ line, block: blockOf(i) }))
        .filter(({ line }) => /^\s*location\b/.test(line))
        .filter(({ block }) => !/frontend_v2/.test(block))
        .map(({ line }) => line)
        .filter((line) => {
          const m = /location\s+(?:\^~|=)?\s*(\/api\/[^\s{]*)/.exec(line);
          return m ? bare.startsWith(m[1]!.replace(/\/$/, '')) && m[1] !== '/api' : false;
        });
      expect(taken, `${file} routes ${prefix} elsewhere`).toEqual([]);
    }
  });
});
