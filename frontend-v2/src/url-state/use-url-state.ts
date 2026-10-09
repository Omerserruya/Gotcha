'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { usePathname, useRouter } from '@/i18n/navigation';

import type { UrlCodec } from './codecs';

/**
 * How a change to URL state affects the back button.
 *
 * This is the decision that determines whether the back button is useful or
 * infuriating, and it is not a detail:
 *
 *   `replace` - typing in a search box, toggling a filter. Pushing here would
 *               make the user press back once per keystroke to leave the page.
 *   `push`    - selecting a conversation, opening a customer. The user expects
 *               back to return them to the list they came from.
 */
export type HistoryMode = 'push' | 'replace';

/**
 * Binds one piece of state to one query parameter.
 *
 * State that matters to navigation belongs in the URL, not in `useState`.
 * Putting it there is what makes a view deep-linkable, survivable across a
 * refresh, shareable with a colleague, and navigable with back and forward -
 * all of which an operations tool is used for constantly.
 *
 * The URL is the source of truth; there is no local copy to fall out of sync.
 */
export function useUrlState<T>(
  key: string,
  codec: UrlCodec<T>,
  options: { readonly history?: HistoryMode } = {},
): readonly [T, (next: T) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const history = options.history ?? 'replace';

  // `codec` is typically constructed inline, so depending on it directly would
  // recompute every render. The parameter's raw string is what actually
  // determines the value.
  const raw = searchParams.get(key);

  const value = useMemo(
    () => codec.decode(raw),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [raw],
  );

  const setValue = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      const encoded = codec.encode(next);

      if (encoded === null) {
        params.delete(key);
      } else {
        params.set(key, encoded);
      }

      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;

      // `scroll: false` - changing a filter must not throw the user back to
      // the top of a list they had scrolled through.
      router[history](href, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, pathname, router, history, key],
  );

  return [value, setValue] as const;
}

/**
 * Binds several parameters at once, updating them in a single navigation.
 *
 * Setting a filter usually means resetting the page to 1 at the same time.
 * Doing that as two `useUrlState` writes produces two history entries and a
 * flash of an impossible state - page 7 of a filter with two results.
 */
export function useUrlStateGroup<TShape extends Record<string, UrlCodec<unknown>>>(
  codecs: TShape,
  options: { readonly history?: HistoryMode } = {},
): readonly [
  { [K in keyof TShape]: TShape[K] extends UrlCodec<infer V> ? V : never },
  (next: Partial<{ [K in keyof TShape]: TShape[K] extends UrlCodec<infer V> ? V : never }>) => void,
] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const history = options.history ?? 'replace';

  const serialised = searchParams.toString();

  const values = useMemo(() => {
    const params = new URLSearchParams(serialised);
    return Object.fromEntries(
      Object.entries(codecs).map(([key, codec]) => [key, codec.decode(params.get(key))]),
    ) as { [K in keyof TShape]: TShape[K] extends UrlCodec<infer V> ? V : never };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialised]);

  const setValues = useCallback(
    (next: Partial<Record<keyof TShape, unknown>>) => {
      const params = new URLSearchParams(serialised);

      for (const [key, value] of Object.entries(next)) {
        const codec = codecs[key];
        if (!codec) continue;
        const encoded = codec.encode(value);
        if (encoded === null) params.delete(key);
        else params.set(key, encoded);
      }

      const query = params.toString();
      router[history](query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serialised, pathname, router, history],
  );

  return [values, setValues] as const;
}
