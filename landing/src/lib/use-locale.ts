'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_LOCALE, type Locale } from '@/lib/site';

const KEY = 'gotcha.locale';

/**
 * Which language these pages are in.
 *
 * Three inputs, in order: `?lang=he` in the URL, then what the reader last
 * chose, then English - the language the design opens in. The query parameter
 * comes first because a legal document gets linked to in a particular language
 * ("here is the Hebrew privacy policy"), and that link has to survive whatever
 * the recipient picked last time.
 *
 * Resolution happens after mount on purpose. These pages are statically
 * generated, so the server has no reader to ask; starting from the default and
 * correcting on the client keeps the markup stable and avoids hydrating over a
 * guess.
 */
export function useLocale(): [Locale, (l: Locale) => void] {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    let next: Locale | null = null;
    try {
      const q = new URLSearchParams(window.location.search).get('lang');
      if (q === 'he' || q === 'en') next = q;
      if (!next) {
        const saved = window.localStorage.getItem(KEY);
        if (saved === 'he' || saved === 'en') next = saved;
      }
    } catch {
      // A private window can throw on storage access; the default is fine.
    }
    if (next && next !== DEFAULT_LOCALE) setLocale(next);
  }, []);

  const choose = useCallback((l: Locale) => {
    setLocale(l);
    try {
      window.localStorage.setItem(KEY, l);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
  }, []);

  return [locale, choose];
}
