import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOCALE_CODES } from './locales';
import { NAMESPACES } from './namespaces';

/**
 * Guards on the message files themselves.
 *
 * Both failures below are invisible until a page renders: next-intl validates
 * the catalogue when the provider mounts, so one bad key takes down the whole
 * layout rather than one string. That is a browser-only failure with no test
 * behind it, which is exactly how it reached the screen once already.
 */

const MESSAGES_DIR = join(process.cwd(), 'src/i18n/messages');

function namespacesOf(locale: string): string[] {
  return readdirSync(join(MESSAGES_DIR, locale))
    .filter((file) => file.endsWith('.json'))
    .sort();
}

function load(locale: string, namespace: string): unknown {
  return JSON.parse(readFileSync(join(MESSAGES_DIR, locale, namespace), 'utf8'));
}

function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

function ownKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...ownKeys(child),
  ]);
}

/** The locale every other is compared against. */
const REFERENCE = LOCALE_CODES[0] ?? 'en';
const OTHERS = LOCALE_CODES.slice(1);

describe('message catalogues', () => {
  /*
   * next-intl reads "." as nesting, so a key containing one is rejected
   * outright. Backend codes are dotted by convention - `intent.automatable`,
   * `refund.completed` - and using one as a literal key crashes the provider,
   * and with it every page.
   */
  it('has no key containing a dot', () => {
    for (const locale of LOCALE_CODES) {
      for (const namespace of namespacesOf(locale)) {
        const offenders = ownKeys(load(locale, namespace)).filter((key) => key.includes('.'));
        expect(offenders, `${locale}/${namespace}`).toEqual([]);
      }
    }
  });

  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ A FILE THAT IS NOT IN `NAMESPACES` IS NEVER LOADED
   * ════════════════════════════════════════════════════════════════════════
   * `loadMessages` maps over `NAMESPACES`, not over the directory. So a
   * namespace file can exist, be complete, match its counterpart key for key,
   * pass every other test in this file - and be **absent at runtime**.
   *
   * That is what happened to `inbox.json`. Screen 02 shipped with its whole
   * catalogue unloaded, and the failure did not look like missing text: a
   * client component asking for a nested namespace (`useTranslations
   * ('inbox.verbs')`) **throws**, so the page had no heading and twelve
   * capture tests reported *"is the app serving on this origin?"*.
   *
   * ── AND A MISSING KEY IS SILENT WHERE A MISSING NAMESPACE IS FATAL ──
   * Worth stating together, because they are the same defect with opposite
   * symptoms: the production fallback returns `''` for an absent KEY, which
   * is how presence-only assertions pass over elements rendering nothing; an
   * absent NAMESPACE raises. The loud one is the kinder one.
   *
   * Both directions are checked. A name in `NAMESPACES` with no file is not
   * harmless either - `loadNamespace` catches the failed import and returns
   * `{}`, so it fails exactly as quietly as the case above.
   *
   * Every other test here reads the namespace list from the DIRECTORY, which
   * is why none of them could see this.
   */
  it('★★ registers every namespace file, and has a file for every registered name', () => {
    const onDisk = namespacesOf(REFERENCE).map((file) => file.replace(/\.json$/, ''));
    const registered = [...NAMESPACES].sort();

    const unregistered = onDisk.filter((name) => !registered.includes(name as never));
    expect(
      unregistered,
      'these catalogues exist and are NEVER LOADED: `loadMessages` maps over ' +
        'NAMESPACES, so a file missing from that list is absent at runtime. Add it ' +
        'to src/i18n/namespaces.ts.',
    ).toEqual([]);

    const fileless = registered.filter((name) => !onDisk.includes(name));
    expect(
      fileless,
      'these names are registered with no file for the reference locale. ' +
        '`loadNamespace` swallows the failed import and returns {}, so the ' +
        'namespace resolves to nothing instead of erroring.',
    ).toEqual([]);
  });

  /*
   * ★★ AND THE CONSUMER SIDE: EVERY NAMESPACE THE CODE ASKS FOR MUST EXIST.
   *
   * The test above catches a catalogue that is never loaded. This catches the
   * mirror: a component asking for a namespace that is not registered - which
   * is what `useTranslations('inbox.verbs')` was doing, and what took screen
   * 02's page down rather than blanking one label.
   *
   * Scanned from the source rather than executed, so it needs no render: a
   * component only proves its own namespace when something renders it, and
   * twelve capture tests were the thing that rendered this one.
   */
  it('★★ every namespace the code asks for is registered', () => {
    const roots = new Set<string>();
    const walkDir = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walkDir(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
      });

    for (const file of walkDir(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:use|get)Translations(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
        /* `useTranslations('inbox.verbs')` names the namespace before the dot. */
        roots.add(match[1]!.split('.')[0]!);
      }
    }

    const registered = new Set<string>(NAMESPACES);
    const unknown = [...roots].filter((root) => !registered.has(root)).sort();
    expect(
      unknown,
      'these namespaces are requested by a component and are not in NAMESPACES, so ' +
        'they do not exist at runtime. A missing KEY renders as an empty string; a ' +
        'missing NAMESPACE throws and takes the page with it.',
    ).toEqual([]);
  });

  it('defines the same namespaces in every locale', () => {
    for (const locale of OTHERS) {
      expect(namespacesOf(locale), locale).toEqual(namespacesOf(REFERENCE));
    }
  });

  /*
   * A key present in one locale and missing in another renders that locale's
   * screen with a raw key on it. Hebrew is not a fallback for English here -
   * it is half the product.
   */
  it('defines the same keys in every locale', () => {
    for (const namespace of namespacesOf(REFERENCE)) {
      const expected = keyPaths(load(REFERENCE, namespace)).sort();
      for (const locale of OTHERS) {
        expect(keyPaths(load(locale, namespace)).sort(), `${locale}/${namespace}`).toEqual(
          expected,
        );
      }
    }
  });
});
