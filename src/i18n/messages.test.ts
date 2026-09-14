import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOCALE_CODES } from './locales';

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
