'use client';

import { Search } from 'lucide-react';
import { useState } from 'react';

import { useRouter } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import ui from '../mobile-ui.module.css';

/**
 * The inbox's search pill: the route's own `search` (the customer's name or
 * handle), sent on Enter as `?q=` with the view and the channel kept. Typing
 * reads nothing: one search per question, not one per letter.
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

  return (
    <form
      role="search"
      className={ui.searchWrap}
      onSubmit={(event) => {
        event.preventDefault();
        const q = text.trim();
        router.replace({ pathname: '/m/inbox', query: { ...keep, ...(q === '' ? {} : { q }) } });
      }}
    >
      <label className={ui.search}>
        <Search aria-hidden size={19} strokeWidth={2} />
        <input
          type="search"
          enterKeyHint="search"
          className={ui.searchInput}
          value={text}
          dir={typedDir(text)}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="mobile-inbox-search"
          onChange={(event) => {
            setText(event.target.value);
            // Cleared with the field's own ×: the whole list again, at once.
            if (event.target.value === '' && value !== '') {
              router.replace({ pathname: '/m/inbox', query: keep });
            }
          }}
        />
      </label>
    </form>
  );
}
