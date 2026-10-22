import { existsSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AUTH_SURFACE_ROUTES, PUBLIC_PATH_PATTERN, SIGNED_OUT_ROUTES } from './auth-surface';

/**
 * The auth-origin build's allowlist, checked against the routes that exist.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ WRITTEN BECAUSE THE SAME CONSTANT HAS NOW FAILED THE SAME WAY TWICE
 * ════════════════════════════════════════════════════════════════════════════
 *   first time   it permitted `/sign-in`, the app redirected to `/en/sign-in`,
 *                and the screen 404'd behind a redirect that looked fine
 *   this time    the recovery screen was added to `(auth)` and the pattern
 *                still said `(?:sign-in)` - an alternation with one branch
 *
 * The first fix taught it about locales; it did not make it a list. Both
 * times the href, the source and the compiled route were all correct, and the
 * origin refused the screen anyway.
 *
 * ★ So this does not assert the list's contents - that would be the same
 *   hardcoded fact written twice, agreeing with itself. It reads the route
 *   directory and requires the allowlist to cover what is actually there.
 *   The next screen someone adds fails this until they permit it.
 */
const AUTH_GROUP = 'src/app/[locale]/(auth)';

const routesOnDisk = readdirSync(AUTH_GROUP, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  // Next's own grouping and private conventions are not routes.
  .filter((name) => !name.startsWith('(') && !name.startsWith('_') && !name.startsWith('@'));

describe('⚠⚠ the auth origin serves every screen of the auth surface', () => {
  it('★★ permits every route in the (auth) group, whatever it is called', () => {
    /*
     * Read from disk, not listed here. A test that repeated the names would
     * pass on the day somebody adds a screen and forgets the allowlist -
     * which is the exact failure it exists to catch.
     */
    expect(routesOnDisk.length, 'no routes found - the path is probably wrong').toBeGreaterThan(0);
    /*
     * ★ The group also holds the pages an emailed link opens (`/join`), which
     *   share its signed-out frame but are NOT the sign-in surface. Each must
     *   be named by one list or the other: a screen in neither is a screen
     *   the gate sends to sign-in, or the auth origin refuses.
     */
    const linkPages = new Set(SIGNED_OUT_ROUTES.map((route) => route.split('/')[0]));
    const onSurface = routesOnDisk.filter((name) => !linkPages.has(name));
    expect([...AUTH_SURFACE_ROUTES].sort()).toEqual([...onSurface].sort());
  });

  it('⚠ and permits nothing that is not a screen', () => {
    /*
     * Both directions. An allowlist that had drifted the other way would open
     * a path on the origin whose entire purpose is to serve almost nothing -
     * a security control, not a convenience.
     */
    for (const permitted of AUTH_SURFACE_ROUTES) {
      expect(routesOnDisk, `${permitted} is allowed but no such route exists`).toContain(permitted);
    }
  });
});

describe('⚠⚠ and the pattern matches every one of them, prefixed or not', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE FIRST TIME THIS CONSTANT FAILED, IT WAS THE LOCALE PREFIX
   * ════════════════════════════════════════════════════════════════════════
   * It permitted `/sign-in`; the app answered 307 to `/en/sign-in`; the screen
   * 404'd behind a redirect that looked fine. The names being right is only
   * half of it - the shape around them is the other half, and each half has
   * now broken once on its own.
   */
  it('★★ bare, locale-prefixed, and with a trailing path', () => {
    for (const route of AUTH_SURFACE_ROUTES) {
      expect(PUBLIC_PATH_PATTERN.test(`/${route}`), `/${route}`).toBe(true);
      expect(PUBLIC_PATH_PATTERN.test(`/${route}/`), `/${route}/`).toBe(true);
      expect(PUBLIC_PATH_PATTERN.test(`/en/${route}`), `/en/${route}`).toBe(true);
      expect(PUBLIC_PATH_PATTERN.test(`/he/${route}`), `/he/${route}`).toBe(true);
      // A query string is not part of the pathname, but a sub-path is.
      expect(PUBLIC_PATH_PATTERN.test(`/en/${route}/anything`)).toBe(true);
    }
  });

  it('⚠⚠ and refuses the product, which is the point of the gate', () => {
    /*
     * Both directions. A pattern that matched everything would satisfy every
     * assertion above and turn the auth origin into the whole product - the
     * outage this gate exists to prevent, inverted.
     */
    for (const denied of [
      '/inbox',
      '/en/inbox',
      '/en/settings/billing',
      '/api/internal',
      '/',
      // Near-misses: the name must be a whole segment.
      '/en/sign-inbox',
      '/en/recovery',
      '/signing-in',
    ]) {
      expect(PUBLIC_PATH_PATTERN.test(denied), denied).toBe(false);
    }
  });
});

describe('★★ every signed-out link page the gate opens is a page that exists', () => {
  /*
   * The other direction of the list: a name in SIGNED_OUT_ROUTES with no
   * page behind it opens a path to nothing. Searched under every route group.
   *
   * ⚠ Blind spot, named: checkout's pages are built on another branch, so
   *   they are not required here - this repo's checkout agent owns them.
   */
  const groups = readdirSync('src/app/[locale]', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('('))
    .map((entry) => `src/app/[locale]/${entry.name}`);

  it.each(SIGNED_OUT_ROUTES.filter((route) => !route.startsWith('checkout')))('%s', (route) => {
    const found = groups.filter((group) => existsSync(`${group}/${route}/page.tsx`));
    expect(found, `${route} has no page.tsx in any route group`).toHaveLength(1);
  });
});
