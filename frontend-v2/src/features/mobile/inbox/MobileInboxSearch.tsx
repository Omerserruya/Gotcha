'use client';

import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useRouter } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import ui from '../mobile-ui.module.css';
import { liveSearch, SEARCH_DEBOUNCE_MS, SEARCH_MAX, searchQuery } from './inbox-search';

/**
 * The inbox's search pill: the route's own `search` (the customer's name or
 * handle), as `?q=` with the view and the channel kept.
 *
 * ★ LIVE (2026-11-03): the list follows the field a pause after the last key,
 *   for an empty field or two characters and more (`inbox-search.ts`). Enter
 *   sends at once, whatever is there.
 *
 * ⚠ NO STALE ANSWER. Each key cancels the pending send, so only the last
 *   pause reads; `sent` is what the address already asks, so a key that
 *   changes nothing after trimming sends nothing; and `keep` is read when
 *   the send happens, not when the key was pressed, so a chip tapped in the
 *   pause is not undone by it. Navigations themselves are Next's: the last
 *   `replace` is the page that renders.
 */
export function MobileInboxSearch({
  value,
  keep,
  placeholder,
}: {
  readonly value: string;
  /** The view and channel in force, carried into the new address. */
  readonly keep: Readonly<Record<string, string>>;
  readonly placeholder: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef(value);
  const kept = useRef(keep);

  useEffect(() => {
    kept.current = keep;
  }, [keep]);
  // The address moved without the field (a back, a notification): it is what is asked now.
  useEffect(() => {
    sent.current = value;
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const send = (q: string) => {
    sent.current = q;
    router.replace({ pathname: '/m/inbox', query: { ...kept.current, ...(q === '' ? {} : { q }) } });
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <form
      role="search"
      className={ui.searchWrap}
      onSubmit={(event) => {
        event.preventDefault();
        cancel();
        send(searchQuery(text));
      }}
    >
      <label className={ui.search}>
        <Search aria-hidden size={19} strokeWidth={2} />
        <input
          type="search"
          enterKeyHint="search"
          className={ui.searchInput}
          value={text}
          maxLength={SEARCH_MAX}
          dir={typedDir(text)}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="mobile-inbox-search"
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            cancel();
            // Cleared with the field's own ×: the whole list again, at once.
            if (next === '') {
              if (sent.current !== '') send('');
              return;
            }
            timer.current = setTimeout(() => {
              timer.current = null;
              const q = liveSearch(next, sent.current);
              if (q !== null) send(q);
            }, SEARCH_DEBOUNCE_MS);
          }}
        />
      </label>
    </form>
  );
}
