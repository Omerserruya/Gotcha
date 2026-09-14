'use client';

import { useEffect, useRef } from 'react';
import { EXTERNAL_PAGE, parsePath, pathFor, type Lang } from '@/lib/pages';

/**
 * Gives the design's in-page navigation a real address.
 *
 * The design switches all 34 pages through `state.page` and never touches the
 * URL - which is correct for a canvas and wrong for a website. Clicking
 * "Pricing" in the footer changed the whole page while the address bar still
 * said `/`, so nothing was linkable, the back button did nothing, and the
 * routes this app generates could only be reached by typing them.
 *
 * This watches the page the landing is showing and keeps the address in step,
 * in both directions:
 *
 *  - page changes  -> pushState to that page's path
 *  - back / forward -> hand the page back to the landing so it re-renders
 *
 * A page the landing knows but this app serves elsewhere - the Help Center,
 * which is a real section rather than the design's placeholder hub - is a full
 * navigation instead, because it is genuinely a different document.
 *
 * The language is part of the address too. Every page has a Hebrew path under
 * /he, so switching language moves between /offer and /he/offer rather than
 * changing the page under a URL that no longer describes it - and a link, in
 * either language, opens in the language it was sent in.
 *
 * Rendered as a component rather than patched into the logic class so it
 * survives `npm run design:sync`: the class is regenerated from the design on
 * every export, this file is not.
 */
export default function UrlSync({
  page,
  onNavigate,
  alwaysNavigate = false,
  lang,
  onLang,
  onUrlLang,
}: {
  page: string;
  onNavigate: (page: string) => void;
  /** The language the chrome is in, so a section can follow its toggle. */
  lang?: string;
  onLang?: (lang: string) => void;
  /** Back or Forward across a language boundary: the address wins. */
  onUrlLang?: (lang: Lang) => void;
  /**
   * True when the chrome is wrapping a hand-written section. From a legal
   * document, picking "Pricing" in the header is a different document, not a
   * view swap, so it has to be a real navigation - the landing's pages are not
   * mounted here to swap to.
   */
  alwaysNavigate?: boolean;
}) {
  // What the address already reflects. Starts as the page and language the
  // route rendered, so the first effect does not push a duplicate entry.
  const shown = useRef(page);
  const shownLang = useRef<Lang>((lang === 'he' ? 'he' : 'en') as Lang);

  useEffect(() => {
    const next: Lang = lang === 'he' ? 'he' : 'en';
    if (page === shown.current && next === shownLang.current) return;

    const external = EXTERNAL_PAGE[page];

    if (external || alwaysNavigate) {
      // A different document: the language travels with it as a path, not as
      // state that would be lost on arrival.
      const to = external ?? pathFor(page, next);
      if (to) window.location.assign(to);
      return;
    }

    const path = pathFor(page, next);
    shown.current = page;
    shownLang.current = next;
    if (path && window.location.pathname !== path) {
      // A language switch pushes, like any other change of address. Replacing
      // it was tried and is worse: the URL changes under you and Back then
      // leaves the site altogether instead of undoing what you just did.
      window.history.pushState({ page, lang: next }, '', path);
      // The design scrolls to the top itself on every page change; doing it
      // here as well would fight it.
    }
  }, [page, lang, alwaysNavigate]);

  // The design's footer carries the only language switch on the site. A
  // hand-written section picks its own document by language, so it has to hear
  // about that rather than grow a second toggle beside it.
  useEffect(() => {
    if (lang && onLang) onLang(lang);
  }, [lang, onLang]);

  useEffect(() => {
    const onPop = () => {
      const found = parsePath(window.location.pathname);
      if (!found) return; // Left the landing entirely; the browser handles it.
      shown.current = found.page;
      shownLang.current = found.lang;
      onNavigate(found.page);
      if (found.lang !== lang) onUrlLang?.(found.lang);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onNavigate, onUrlLang, lang]);

  return null;
}
