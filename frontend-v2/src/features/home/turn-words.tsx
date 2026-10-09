'use client';

import {
  createFormatter,
  createTranslator,
  useFormatter,
  useLocale,
  useTimeZone,
  useTranslations,
  type AbstractIntlMessages,
} from 'next-intl';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { TurnLang } from '@/api/contracts/assistant-threads';

/**
 * ★★ AN ANSWER'S OWN CHROME IS IN THE TURN'S LANGUAGE (supervisor, measured on
 * dev): a Hebrew question on /en got Hebrew steps and titles from the server,
 * and "17 in all", "done · under 1s" from us. The turn's words - step status
 * and time, "N in all", coverage, "Stopped", a refusal - follow the turn
 * (`lang`, Backend d43ba57c); the page's - the header, the scope, the
 * composer, Share - stay the interface's.
 *
 * ⚠ Not a nested NextIntlClientProvider: `Link` takes its locale from that
 *   context, so a source chip or the billing link inside a Hebrew turn on /en
 *   would have gone to /he. Only words and formats change here; every link
 *   keeps the page's locale.
 *
 * The words come from the server (`home.conversation`, in each language),
 * so neither catalogue is bundled whole into the page.
 */

/** `home.conversation` in each language a turn can be in. */
export type AnswerWords = Partial<Record<TurnLang, AbstractIntlMessages>>;

const AnswerWordsContext = createContext<AnswerWords>({});
const TurnContext = createContext<{
  readonly lang: string;
  readonly words: AbstractIntlMessages;
} | null>(null);

/** Every language's answer chrome, for the turns below. */
export function AnswerWordsProvider({
  words,
  children,
}: {
  readonly words: AnswerWords;
  readonly children: ReactNode;
}) {
  return <AnswerWordsContext.Provider value={words}>{children}</AnswerWordsContext.Provider>;
}

/**
 * One turn's chrome in its language - when it has one, it is not the page's,
 * and its words were sent. Otherwise the page's, as before.
 */
export function TurnWords({
  lang,
  children,
}: {
  readonly lang: TurnLang | null;
  readonly children: ReactNode;
}) {
  const page = useLocale();
  const all = useContext(AnswerWordsContext);
  const words = lang && lang !== page ? all[lang] : undefined;
  const value = useMemo(() => (lang && words ? { lang, words } : null), [lang, words]);
  return <TurnContext.Provider value={value}>{children}</TurnContext.Provider>;
}

type Namespace =
  | 'home.conversation'
  | 'home.conversation.step'
  | 'home.conversation.problem'
  | 'home.conversation.blocks';

/** `useTranslations`, in the turn's language when it has its own. */
export function useTurnTranslations<N extends Namespace>(namespace: N) {
  const page = useTranslations(namespace);
  const turn = useContext(TurnContext);
  return useMemo(() => {
    if (!turn) return page;
    const sub = namespace.slice('home.conversation'.length).replace(/^\./, '');
    return createTranslator({
      locale: turn.lang,
      messages: turn.words,
      ...(sub ? { namespace: sub } : {}),
    } as Parameters<typeof createTranslator>[0]) as unknown as typeof page;
  }, [page, turn, namespace]);
}

/** `useFormatter`, in the turn's language when it has its own - dates and numbers too. */
export function useTurnFormatter() {
  const page = useFormatter();
  const timeZone = useTimeZone();
  const turn = useContext(TurnContext);
  return useMemo(
    () => (turn ? (createFormatter({ locale: turn.lang, timeZone }) as typeof page) : page),
    [page, turn, timeZone],
  );
}

/** The turn's language, for `lang=` on its answer; `undefined` when it is the page's. */
export function useTurnLang(): string | undefined {
  return useContext(TurnContext)?.lang;
}
