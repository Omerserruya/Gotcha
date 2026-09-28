import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMessages } from './load-messages';
import { CREDENTIAL_SURFACE_NAMESPACES, NAMESPACES, SHELL_NAMESPACES } from './namespaces';

/**
 * What the pre-authentication page is allowed to send to a stranger.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE SIGN-IN PAGE SHIPPED THE PRODUCT'S ENTIRE VOCABULARY
 * ════════════════════════════════════════════════════════════════════════════
 * `NextIntlClientProvider` with no `messages` serialises every namespace in
 * the request config into the client payload. Measured on the deployed page:
 * 143,757 bytes, 1,097 message-shaped strings — "Approvals", "Studio",
 * "conversation" x121, "refund" x20, and a warning naming the Approvals queue
 * — on a page nobody has authenticated to reach.
 *
 * ── WHY THIS READS THE CALL SITES ──
 * A hand-kept list of "what sign-in needs" fails silently in the direction
 * nobody notices: a missing namespace renders a **blank string**, and a blank
 * string on a sign-in screen is indistinguishable from a page that simply says
 * less. The same failure mode that hid three whole catalogues from
 * `NAMESPACES` and took a dead screen to find.
 *
 * So the set is checked against the `useTranslations` / `getTranslations`
 * calls in the code that renders there, in both directions: nothing asked for
 * is missing, and nothing unasked-for is carried.
 */

const SURFACE_DIRECTORIES = [
  'src/features/auth',
  'src/app/[locale]/(auth)',
  // A superset: only a few of these render on the auth route, and scanning all
  // of them can only make the requirement stricter, never looser.
  'src/design-system',
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(directory);
  return found;
}

/** The first segment of every namespace the auth surface asks for. */
function namespacesRequested(): Set<string> {
  const requested = new Set<string>();
  for (const directory of SURFACE_DIRECTORIES) {
    for (const file of sourceFiles(directory)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:use|get)Translations\(\s*'([^']+)'/g)) {
        // `useTranslations('auth.secondFactor')` is still the `auth` catalogue.
        requested.add(match[1]!.split('.')[0]!);
      }
    }
  }
  return requested;
}

describe('⚠⚠ the credential surface carries its own vocabulary and no more', () => {
  it('⚠⚠ covers every namespace the auth surface actually asks for', () => {
    const requested = [...namespacesRequested()].sort();
    // Read, not assumed: if somebody adds `useTranslations('billing')` to a
    // design-system primitive, this reddens rather than blanking a string.
    expect(requested.length, 'no call sites found — the scan is broken').toBeGreaterThan(0);
    for (const namespace of requested) {
      expect(CREDENTIAL_SURFACE_NAMESPACES as readonly string[], namespace).toContain(namespace);
    }
  });

  it('⚠⚠ carries nothing the surface does not ask for', () => {
    /*
     * The direction that matters. "Covers what is needed" is satisfied by
     * shipping everything — which is exactly the defect. This is the assertion
     * that fails if somebody widens the set for comfort.
     */
    const requested = namespacesRequested();
    for (const namespace of CREDENTIAL_SURFACE_NAMESPACES) {
      expect([...requested], namespace).toContain(namespace);
    }
  });

  it('⚠⚠ names no product feature at all', () => {
    /*
     * Stated as the property rather than as a count, so it keeps meaning
     * something as namespaces are added. Every namespace that is not part of
     * the credential surface or the shell is product vocabulary, and none of
     * it may be on this page.
     */
    const allowed = new Set<string>([...CREDENTIAL_SURFACE_NAMESPACES, ...SHELL_NAMESPACES]);
    const product = NAMESPACES.filter((namespace) => !allowed.has(namespace));
    expect(product, 'every namespace is allowed — the test proves nothing').not.toHaveLength(0);
    for (const namespace of product) {
      expect(CREDENTIAL_SURFACE_NAMESPACES as readonly string[], namespace).not.toContain(
        namespace,
      );
    }
  });

  it('★★ and the loader honours the narrowing, or none of the above matters', async () => {
    /*
     * The list is a claim about a constant; this is the claim about what
     * reaches the browser. `loadMessages` defaulting to everything is how the
     * page came to carry everything in the first place.
     */
    const scoped = await loadMessages('en', CREDENTIAL_SURFACE_NAMESPACES);
    expect(Object.keys(scoped).sort()).toEqual([...CREDENTIAL_SURFACE_NAMESPACES].sort());
    expect(scoped).not.toHaveProperty('approvals');
    expect(scoped).not.toHaveProperty('inbox');

    // Both directions: a loader that returned nothing satisfies all of that.
    expect(Object.keys(scoped.auth as object).length).toBeGreaterThan(0);

    // And the default is still the whole catalogue, which the product needs.
    const full = await loadMessages('en');
    expect(Object.keys(full).sort()).toEqual([...NAMESPACES].sort());
  });

  it('★ the shell set is what the route error boundary needs, above both groups', () => {
    /*
     * `error.tsx` is a client component by Next's requirement and lives at the
     * locale root, outside `(app)` and `(auth)` alike. If its namespace is not
     * provided above them, an error on the sign-in route renders empty strings
     * — a failure that looks like a quiet page rather than a broken one.
     */
    expect(SHELL_NAMESPACES as readonly string[]).toContain('errors');
    const source = readFileSync('src/app/[locale]/error.tsx', 'utf8');
    for (const match of source.matchAll(/useTranslations\(\s*'([^'.]+)/g)) {
      expect(SHELL_NAMESPACES as readonly string[], match[1]).toContain(match[1]);
    }
  });
});
