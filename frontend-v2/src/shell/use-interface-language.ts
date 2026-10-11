'use client';

import { useLocale } from 'next-intl';
import { unstable_rethrow, useSearchParams } from 'next/navigation';
import { useRef, useTransition } from 'react';

import { isLocale } from '@/i18n/locales';
import { usePathname, useRouter } from '@/i18n/navigation';
import { logger } from '@/observability/logger';

import { saveMyLanguage } from './locale-actions';

/** The page's query as next-intl takes it, a repeated key kept as a list. */
function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    query[key] = values.length === 1 ? values[0]! : values;
  }
  return query;
}

/**
 * THE personal language switch - the rail's account menu, and the person's
 * own row in 12d. One switch, so the two cannot drift.
 *
 * Choosing a language keeps it on the account first, then reopens this same
 * page - its query too (`?person=`, `?panel=`) - in that language; the
 * language is the address (`/he/...`).
 *
 * ★ A FAILED KEEP STILL SWITCHES THE PAGE, QUIETLY. The person asked to see
 *   the page in that language, and they do; what did not happen is that the
 *   next device or the next sign-in remembers it. That is logged here (and by
 *   the action, with the cause), and not said on screen: a sentence would
 *   have to survive the navigation it follows, and "we could not remember
 *   this" on a page that is already in the language they chose reads as
 *   "it did not work" when it did.
 *
 * ★ A signed-out session is the exception: the action sends it to sign-in
 *   (a redirect, which reaches here as a thrown navigation). That is
 *   rethrown and the page is NOT switched - one navigation, never two.
 *
 * Choosing the language already shown does nothing: no write, no
 * navigation. A second choice while the first is in flight is dropped.
 */
export function useInterfaceLanguage(): {
  readonly current: string;
  readonly choose: (next: string) => void;
  readonly isPending: boolean;
} {
  const current = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  /** The language being switched to, until the page is in it. */
  const inFlight = useRef<string | null>(null);

  function choose(next: string) {
    if (!isLocale(next) || next === current) return;
    if (inFlight.current !== null && inFlight.current !== current) return;
    inFlight.current = next;
    const query = queryOf(new URLSearchParams(searchParams.toString()));
    startTransition(async () => {
      try {
        const kept = await saveMyLanguage(next);
        if (!kept.ok) logger.warn('shell.my_locale_not_kept', { locale: next });
      } catch (cause) {
        // A redirect to sign-in is the framework's navigation: let it happen alone.
        unstable_rethrow(cause);
        logger.warn('shell.my_locale_not_kept', { locale: next, cause });
      }
      router.replace({ pathname, query }, { locale: next });
    });
  }

  return { current, choose, isPending };
}
