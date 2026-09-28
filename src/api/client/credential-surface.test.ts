import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refuseOnCredentialSurface } from './credential-surface';

/**
 * The route handlers the middleware's refusal cannot see.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ `proxy.ts`'s MATCHER EXCLUDES `/api`
 * ════════════════════════════════════════════════════════════════════════════
 * Every page route on the sign-in origin is refused twice — by the gateway
 * allowlist and by the app. `/api/bff/…`, which forwards the caller's platform
 * session upstream, had the allowlist and nothing else, because middleware
 * never runs for a route handler.
 *
 * ★ The guard read as covering the app. It covered the part of the app its
 *   matcher could see — the same defect as a sweep organised by file: correct
 *   about everything it examines, silent about what it does not.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('⚠⚠ refusing on the sign-in origin', () => {
  const request = () => new NextRequest('https://auth-dev.gotcha.co.il/api/bff/api/conversations');

  it('⚠⚠ refuses when this build is the sign-in origin', () => {
    vi.stubEnv('PRODUCT_LOGIN_URL', 'https://dev.gotcha.co.il/v2/api/auth/login');
    const refusal = refuseOnCredentialSurface(request());
    expect(refusal?.status).toBe(404);
  });

  it('★★ and does nothing on the product, or every API call 404s', () => {
    /*
     * Both directions. The whole failure mode this design trades away is a
     * value on the wrong image — and here it would take out every API call in
     * the product rather than only its pages.
     */
    expect(refuseOnCredentialSurface(request())).toBeNull();
  });

  it('★ the refusal is not storable', () => {
    /*
     * It is an answer about which deployment is running. A browser holding it
     * across a configuration change would be answering for the wrong one.
     */
    vi.stubEnv('PRODUCT_LOGIN_URL', 'https://dev.gotcha.co.il/v2/api/auth/login');
    expect(refuseOnCredentialSurface(request())?.headers.get('cache-control')).toBe('no-store');
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ THE PROPERTY IS "EVERY HANDLER", WHICH NO UNIT TEST CAN SEE
   * ══════════════════════════════════════════════════════════════════════════
   * A test that drove one route would pass while a sixth was added without the
   * guard, and that is exactly how this rots — not a guard written wrongly, a
   * route added later. So the set is read from the DIRECTORY rather than from
   * a list somebody maintains, which is the same reason `messages.test.ts`
   * enumerates its folder.
   */
  it('⚠⚠ the matcher no longer skips a path because it contains a dot', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════════
     * THIS ASSERTION USED TO PIN THE HOLE. IT NOW PINS THE FIX.
     * ═══════════════════════════════════════════════════════════════════════════
     * `.*\..*` meant "a dot anywhere", so `/en/customers/a.b@c.com` skipped the
     * credential-surface refusal, the auth gate AND the narrowed CSP —
     * reproduced against the deployed image as a `307` where every other
     * product path answered `404`.
     *
     * ★ The old version of this test asserted the path was NOT matched, with a
     *   note saying that narrowing the exclusion should redden it so somebody
     *   re-read it rather than silently satisfying it. Narrowing it did, and
     *   this is the re-read.
     *
     * The matcher is read from `proxy.ts`, not copied, so this cannot pin a
     * matcher that was true when somebody wrote it down.
     */
    const source = readFileSync('src/proxy.ts', 'utf8');
    const declared = /matcher: \[(.*?)\]/s.exec(source)?.[1] ?? '';
    const pattern = /'\/\(\((.*?)\)\.\*\)'/.exec(declared)?.[1];
    expect(pattern, 'the matcher is not in the shape this test reads').toBeTruthy();

    /*
     * ⚠ The source is a STRING literal, so `\\.` there is `\.` in the regex it
     *   builds. Reading it back without undoing that escape produced a pattern
     *   matching a literal backslash — and the first run of this test claimed
     *   the dotted path was covered. The extraction was wrong in the
     *   reassuring direction, which is the only direction that matters.
     */
    const matches = new RegExp(`^/((${pattern!.replaceAll('\\\\', '\\')}).*)$`);

    expect(matches.test('/en/home')).toBe(true);

    /*
     * ⚠⚠ THE SECOND HALF OF THIS DEFECT, AND THE FIRST FIX DID NOT CLOSE IT.
     * A lookahead need not reach the end of the string, so an UNANCHORED
     * `.*\.(?:…|js|…)` means "a dot followed by something that BEGINS WITH a
     * listed extension" — the trailing `.*` eats the rest. The extension list
     * shrank the hole rather than closing it.
     *
     * ★★ `a.jsmith@company.com` is what "J. Smith" looks like. These are not
     *   contrived probes; they are the likeliest strings in that column, and
     *   every probe I wrote for the first fix (`a.b`, `v1.2`, `u.1`) happened
     *   to have a dot followed by something that starts no extension. **The
     *   probe set was built from the shapes I had already seen.**
     */
    for (const id of [
      'a.b@c.com',
      'j.smith@c.com',
      'a.jsmith@c.com', // .js  + mith
      'a.mapleton@c.com', // .map + leton
      'x.pdfoo@c.com', // .pdf + oo
      'a.txtra@c.com', // .txt + ra
      'n.svgator@c.com', // .svg + ator
      'q.icourt@c.com', // .ico + urt
      'w.ttfield@c.com', // .ttf + ield
      // ★ Controls, not witnesses: these pass under BOTH forms, because what
      //   follows the dot begins no listed extension. They are the shapes my
      //   original probe set was made of, which is why it proved nothing.
      'e.otter@c.com',
      'v1.2',
    ]) {
      expect(matches.test(`/en/customers/${id}`), id).toBe(true);
    }

    /*
     * ★ And the symptom the bug was hiding: `/anything.json` was SKIPPED, not
     *   because `json` is listed — it is not — but because `.js` matched and
     *   `on` was eaten. It looked like correct behaviour from an extension
     *   that does not exist in the list.
     */
    expect(matches.test('/anything.json')).toBe(true);
    expect(matches.test('/anything.wasm')).toBe(true);

    // ★ And both directions: the exclusion still has to exclude. An extension
    //   list that matched nothing would satisfy every assertion above and put
    //   the auth gate in front of a favicon.
    expect(matches.test('/api/bff/api/conversations')).toBe(false);
    expect(matches.test('/_next/static/chunk.js')).toBe(false);
    for (const asset of ['/favicon.ico', '/robots.txt', '/sitemap.xml', '/fonts/x.woff2']) {
      expect(matches.test(asset), asset).toBe(false);
    }
  });

  it('★ and the cookie that made the gap survivable is still host-only', () => {
    /*
     * The gap is closed in the matcher now, so this is no longer what stands
     * between a signed-in visitor and a product page on the sign-in origin —
     * but it was, and nothing said so. Kept because the reasoning at
     * `sessionCookieOptions` refers to it, and a note whose assertion has been
     * deleted is a claim again.
     */
    const session = readFileSync('src/auth/session.ts', 'utf8');
    const body = session.slice(session.indexOf('export function sessionCookieOptions'));
    const start = body.indexOf('return {');
    // ⚠ Measured from `start`, not from the function: the RETURN TYPE is also
    //   an object literal, so the first `\n}` in the function closes the
    //   annotation and a slice ending there is empty.
    const returned = body.slice(start, start + body.slice(start).indexOf('\n}'));
    expect(returned, 'sessionCookieOptions is not where this test looks').toContain('sameSite');
    expect(returned).not.toMatch(/^\s*domain:/m);
  });

  it('⚠⚠ every route handler in the app calls it', () => {
    const handlers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === 'route.ts') handlers.push(path);
      }
    };
    walk('src/app/api');

    expect(handlers.length, 'no route handlers found — the scan is broken').toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(readFileSync(handler, 'utf8'), handler).toContain(
        'refuseOnCredentialSurface(request)',
      );
    }
  });
});
