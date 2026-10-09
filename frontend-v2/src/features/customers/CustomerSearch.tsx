'use client';

import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';

import styles from './Customers.module.css';

/** How long after the last keystroke the list is asked again. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * 04's search, live (Omer, 2026-10-07): the list follows the field as it is
 * typed - no Enter needed; Enter still searches at once.
 *
 * ★ The query is the URL's (`?q=`), and the page reads it on the server, so
 *   a search stays linkable and survives a reload. It is REPLACED, never
 *   pushed: Back does not walk through every letter.
 * ★ A navigation in a transition: the list on screen stays until the next
 *   one is ready, with a quiet mark in the field meanwhile - never the
 *   page's skeleton. A newer navigation supersedes an older one (the router
 *   commits the latest), so a slow answer to "ab" cannot land over "abc".
 * ★ An empty field is the full list: `q` goes, the rest of the URL stays.
 */
export function CustomerSearch({
  query,
  label,
  placeholder,
  busyLabel,
}: {
  readonly query: string;
  readonly label: string;
  readonly placeholder: string;
  readonly busyLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(query);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const search = (typed: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const q = typed.trim();
    const next = new URLSearchParams(params?.toString() ?? '');
    if ((next.get('q') ?? '') === q) return;
    if (q) next.set('q', q);
    else next.delete('q');
    const rest = next.toString();
    start(() => {
      router.replace((rest ? `${pathname}?${rest}` : pathname) as Route, { scroll: false });
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    search(value);
  };

  return (
    <form
      className={styles.search}
      role="search"
      onSubmit={submit}
      data-testid="customer-search"
      aria-busy={busy}
    >
      <label className="srOnly" htmlFor="customer-q">
        {label}
      </label>
      <span className={styles.searchField}>
        <input
          id="customer-q"
          name="q"
          type="search"
          className={styles.searchInput}
          value={value}
          dir="auto"
          onChange={(e) => {
            const typed = e.target.value;
            setValue(typed);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => search(typed), SEARCH_DEBOUNCE_MS);
          }}
          placeholder={placeholder}
          data-testid="customer-search-input"
        />
        {busy ? (
          <span
            className={styles.searchBusy}
            role="status"
            aria-label={busyLabel}
            data-testid="customer-search-busy"
          />
        ) : null}
      </span>
    </form>
  );
}
