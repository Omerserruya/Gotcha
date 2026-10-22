import 'server-only';

import { TURN_LANGS } from '@/api/contracts/assistant-threads';
import { loadMessages } from '@/i18n/load-messages';

import type { AnswerWords } from './turn-words';

/**
 * `home.conversation` in every language a turn can be written in - the
 * answer's own chrome, sent with the page so a Hebrew turn on /en says
 * "17 בסך הכול" without the whole Hebrew catalogue in the bundle.
 */
export async function loadAnswerWords(): Promise<AnswerWords> {
  const entries = await Promise.all(
    TURN_LANGS.map(async (lang) => {
      const home = (await loadMessages(lang, ['home'])).home as {
        conversation?: AnswerWords[typeof lang];
      };
      return [lang, home?.conversation ?? {}] as const;
    }),
  );
  return Object.fromEntries(entries);
}
