import { describe, expect, it } from 'vitest';

import { loadMessages } from './load-messages';
import { LOCALE_CODES } from './locales';

/**
 * What the app actually loads, through the function the app actually calls.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ EVERY OTHER TEST OVER THE CATALOGUES READS THE DIRECTORY OR THE FILE
 * ════════════════════════════════════════════════════════════════════════════
 * `messages.test.ts` lists namespaces with `readdirSync`. Component tests
 * import a JSON file and hand it to `createTranslator` or
 * `NextIntlClientProvider`. Both are true statements about files on disk and
 * neither says anything about what reaches a page.
 *
 * `loadMessages` maps over `NAMESPACES`, so a complete, both-locale,
 * key-for-key-matching catalogue that is missing from that array **does not
 * exist at runtime** — and three were. `inbox` was the loud one: a client
 * component asking for a nested namespace throws, so screen 02 rendered no
 * heading at all and twelve capture tests reported *"is the app serving on
 * this origin?"*.
 *
 * This file closes the loop by asking the loader.
 */

/** Namespaces with a live consumer, and the key that proves each one loaded. */
const LOAD_BEARING = [
  /*
   * The one that took a screen down. `useTranslations('inbox.verbs')` in
   * `ConversationVerbs` resolves this nested branch, and a missing NAMESPACE
   * raises rather than returning '' — which is why this was fatal where a
   * missing key is silent.
   */
  ['inbox', 'verbs.claim'],
  ['inbox', 'stream.system.agent_claimed'],
  /* Screen 06's two panels — the two branches its components read. */
  ['analytics', 'team.heading'],
  ['analytics', 'asked.heading'],
  /*
   * Screen 13's signup outcome, emitted by `whatsapp-signup-flow.ts` as a
   * fully-qualified dotted key from the ROOT of the merged catalogue. With the
   * namespace unregistered this resolved to nothing at all.
   */
  ['whatsappNumbers', 'outcome.noCandidates'],
] as const;

const at = (messages: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);

describe('★★ the loader, not the directory', () => {
  for (const locale of LOCALE_CODES) {
    it(`★★ ${locale}: every load-bearing namespace reaches the merged catalogue`, async () => {
      const messages = await loadMessages(locale);

      for (const [namespace, key] of LOAD_BEARING) {
        const branch = (messages as Record<string, unknown>)[namespace];
        expect(branch, `${locale}: the "${namespace}" namespace did not load at all`).toBeDefined();

        const value = at(branch, key);
        expect(typeof value, `${locale}: ${namespace}.${key}`).toBe('string');
        expect((value as string).length, `${locale}: ${namespace}.${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('★ loads every registered namespace, and each one has content', async () => {
    /*
     * The other direction of the same defect: a name in `NAMESPACES` with no
     * file is not an error — `loadNamespace` catches the failed import and
     * returns `{}`. So the namespace resolves, every key under it is missing,
     * and missing keys are silent. An empty branch is the signature.
     */
    const { NAMESPACES } = await import('./namespaces');
    const messages = (await loadMessages(LOCALE_CODES[0]!)) as Record<string, unknown>;

    const empty = NAMESPACES.filter(
      (namespace) => Object.keys((messages[namespace] ?? {}) as object).length === 0,
    );
    expect(
      empty,
      'these namespaces loaded as {} — the import failed and was swallowed, so every ' +
        'key under them renders as nothing',
    ).toEqual([]);
  });
});
