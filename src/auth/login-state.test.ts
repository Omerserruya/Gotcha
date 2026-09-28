import { describe, expect, it } from 'vitest';

import { safeReturnPath } from './login-state';

describe('safeReturnPath', () => {
  it('accepts an in-app path', () => {
    expect(safeReturnPath('/inbox/123?filter=open')).toBe('/inbox/123?filter=open');
  });

  it('★ keeps the fragment, which is where a deep link lives', () => {
    expect(safeReturnPath('/settings/people#roles')).toBe('/settings/people#roles');
  });

  const hostile: readonly (readonly [string | null, string])[] = [
    ['https://evil.example', 'an absolute URL'],
    ['//evil.example', 'a protocol-relative URL'],

    /*
     * ★★ THE TWO ABOVE CANNOT TELL A WORKING GUARD FROM A BROKEN ONE.
     * Both have an EMPTY path, so a guard that discarded the host and kept the
     * path would return `'/'` for them and look correct. Mutation testing
     * proved it: removing the origin check entirely left all of these green.
     *
     * An attacker sends the page they want the victim on, so the real payload
     * has a path. These two are the same attacks with one.
     */
    ['https://evil.example/inbox/123', 'an absolute URL that carries a path'],
    ['//evil.example/inbox/123', 'a protocol-relative URL that carries a path'],

    /*
     * ★★ AND THIS ONE DEFEATED THE FIX, NOT THE ORIGINAL.
     * It resolves to our own origin — the smuggled host is not in the URL when
     * it is parsed. `.` collapses to nothing and the pathname comes back as
     * `//evil.example`: an authority MANUFACTURED by normalisation, which the
     * origin comparison cannot see because it happened afterwards.
     */
    ['/.//evil.example', 'an authority manufactured by path normalisation'],
    ['/foo/..//evil.example', 'the same, reached through a real segment'],
    ['/\\evil.example', 'a backslash-smuggled host'],
    ['javascript:alert(1)', 'a javascript URL'],
    ['', 'an empty value'],
    [null, 'null'],
    /*
     * Not hostile — it resolves to this origin — but every caller produces an
     * absolute in-app path, so accepting it would widen the shape for nothing.
     * Pinned because resolution alone would let it through.
     */
    ['inbox/123', 'a path with no leading slash'],

    /*
     * ════════════════════════════════════════════════════════════════════════
     * ★★ THE SIX ABOVE ARE THE SHAPES SOMEBODY THOUGHT OF. THESE THREE WALKED
     *    THROUGH ALL OF THEM.
     * ════════════════════════════════════════════════════════════════════════
     * The URL parser strips tab, LF and CR from ANYWHERE in a URL before it
     * parses. The old guard read the first two characters, so a tab between
     * the slashes satisfied every check and then vanished, leaving `//host`.
     *
     * Each of these was measured producing `https://evil.example/`, not
     * reasoned about.
     */
    ['/\t/evil.example', 'a TAB between the slashes'],
    ['/\n/evil.example', 'a newline between the slashes'],
    ['/\r/evil.example', 'a carriage return between the slashes'],
    ['/\t\\evil.example', 'a tab and a backslash together'],
  ];

  for (const [candidate, description] of hostile) {
    it(`rejects ${description}`, () => {
      expect(safeReturnPath(candidate)).toBe('/');
    });
  }

  it('★ a stripped character that does NOT move the origin still goes nowhere off-site', () => {
    /*
     * `/\tevil.example` — one slash — is a path on this origin, not an
     * authority. It is not hostile and does not need rejecting; what matters is
     * only that it cannot leave. Asserting the exact output here rather than
     * `'/'` records which side of the line it falls on, because a guard that
     * rejects it too would look identical on the hostile cases above.
     */
    expect(safeReturnPath('/\tevil.example')).toBe('/evil.example');
  });

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ THE PROPERTY, NOT THE LIST — AND THE BASE PATH THAT WAS HIDING IT
   * ══════════════════════════════════════════════════════════════════════════
   * The list above can only ever hold the spellings somebody wrote down. This
   * asks the question the value exists to answer: after `appUrl` composes it
   * the way the callback does, does the browser end up on our origin?
   *
   * ★ It runs at BOTH mount points on purpose. Under `/v2` the prefix absorbs
   *   a smuggled authority (`/v2\t/evil` -> `/v2/evil`), so the defect was
   *   invisible in the only deployment anyone looks at. At `''` — local dev,
   *   and a root-mounted build of this source for a separate auth origin —
   *   nothing absorbs it. A test at one mount point would have passed all day.
   */
  describe('★★ composed the way the callback composes it, at either mount point', () => {
    const ORIGIN = 'https://dev.gotcha.co.il';

    /** `appUrl`, inlined: `${origin}${BASE_PATH}${path}`, then parsed. */
    const landsOn = (basePath: string, candidate: string): string =>
      new URL(`${ORIGIN}${basePath}${safeReturnPath(candidate)}`).origin;

    /*
     * ★ The OTHER way a caller would compose this, and the one that is not in
     *   the codebase today. `new URL(path, origin)` is the ordinary spelling,
     *   and it is strictly less forgiving than concatenation: it reads a
     *   leading `//` as an authority. Asserting it here means the value is safe
     *   for a caller we have not written yet, rather than safe because of how
     *   the one caller we have happens to build a string.
     */
    const resolvedFrom = (basePath: string, candidate: string): string =>
      new URL(safeReturnPath(candidate), `${ORIGIN}${basePath}/`).origin;

    for (const basePath of ['', '/v2']) {
      const where = basePath === '' ? 'at the root' : `under ${basePath}`;

      it(`⚠⚠ cannot be sent off-site ${where}`, () => {
        for (const [candidate] of hostile) {
          if (candidate === null) continue;
          expect(landsOn(basePath, candidate), candidate).toBe(ORIGIN);
        }
      });

      it(`⚠⚠ nor by a caller that resolves instead of concatenating ${where}`, () => {
        for (const [candidate] of hostile) {
          if (candidate === null) continue;
          expect(resolvedFrom(basePath, candidate), candidate).toBe(ORIGIN);
        }
      });

      it(`★ and still carries a real destination ${where}`, () => {
        /*
         * Both directions. A `safeReturnPath` that returned `'/'` for
         * everything would satisfy every assertion above and quietly strand
         * every person who signed in from a deep link.
         */
        expect(safeReturnPath('/inbox/123?filter=open')).toBe('/inbox/123?filter=open');
        expect(landsOn(basePath, '/inbox/123?filter=open')).toBe(ORIGIN);
      });
    }
  });

  it('★★ what it returns is already canonical, so a second parse cannot move it', () => {
    /*
     * The original defect was not only the missing spellings — it was checking
     * one string and redirecting to a different one. Resolving the output again
     * must be a no-op, or some later `new URL` can still reinterpret a value
     * this function approved.
     */
    for (const [candidate] of hostile) {
      if (candidate === null) continue;
      const once = safeReturnPath(candidate);
      expect(safeReturnPath(once), candidate).toBe(once);
    }
    expect(safeReturnPath(safeReturnPath('/inbox/123?filter=open'))).toBe('/inbox/123?filter=open');
  });
});
