'use client';

import { Search } from 'lucide-react';
import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';

import { SEARCH_DEBOUNCE_MS } from '@/features/customers/CustomerSearch';
import { typedDir } from '@/lib/typed-dir';

import ui from '../mobile-ui.module.css';

/**
 * The customers' search pill, as the phone's design draws it - the
 * website's search underneath (`CustomerSearch`): the query is the URL's
 * `?q=`, REPLACED as it is typed (Back does not walk every letter), read on
 * the server by `loadCustomers`. An empty field is the whole list.
 */
export function MobileCustomerSearch({
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
      className={ui.searchWrap}
      role="search"
      onSubmit={submit}
      aria-busy={busy}
      data-testid="mobile-customer-search"
    >
      <label className={ui.search}>
        <Search size={19} strokeWidth={2} aria-hidden="true" />
        <span className="srOnly">{label}</span>
        <input
          name="q"
          type="search"
          className={ui.searchInput}
          value={value}
          dir={typedDir(value)}
          enterKeyHint="search"
          placeholder={placeholder}
          aria-describedby={busy ? 'mobile-customer-search-busy' : undefined}
          onChange={(event) => {
            const typed = event.target.value;
            setValue(typed);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => search(typed), SEARCH_DEBOUNCE_MS);
          }}
        />
        {busy ? (
          <span id="mobile-customer-search-busy" className="srOnly" role="status">
            {busyLabel}
          </span>
        ) : null}
      </label>
    </form>
  );
}
