'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_LOCALE, type Locale } from '@/lib/site';

/**
 * The language the page is actually in, read from the page itself.
 *
 * The cookie notice is mounted in the root layout, outside the chrome, so it
 * cannot be handed the language as a prop. But the chrome writes it onto its
 * own root element - `<div dir lang>` is the first thing the design renders -
 * so the notice can just look, and keep looking: the language switch changes
 * that attribute rather than remounting anything.
 *
 * Without this the notice sat in English above a Hebrew page.
 */
export function usePageLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const root = document.querySelector('[dir][lang]') ?? document.querySelector('[dir]');
    if (!root) return;

    const read = () => {
      const lang = root.getAttribute('lang');
      const dir = root.getAttribute('dir');
      setLocale(lang === 'he' || dir === 'rtl' ? 'he' : 'en');
    };

    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['lang', 'dir'] });
    return () => observer.disconnect();
  }, []);

  return locale;
}
