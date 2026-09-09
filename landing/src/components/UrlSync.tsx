'use client';

import { useEffect, useRef } from 'react';
import { PATH_BY_PAGE, PAGE_BY_PATH, EXTERNAL_PAGE } from '@/lib/pages';

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
 * Rendered as a component rather than patched into the logic class so it
 * survives `npm run design:sync`: the class is regenerated from the design on
 * every export, this file is not.
 */
export default function UrlSync({
  page,
  onNavigate,
}: {
  page: string;
  onNavigate: (page: string) => void;
}) {
  // What the address already reflects. Starts as the page the route rendered,
  // so the first effect does not push a duplicate entry for it.
  const shown = useRef(page);

  useEffect(() => {
    if (page === shown.current) return;

    const external = EXTERNAL_PAGE[page];
    if (external) {
      window.location.assign(external);
      return;
    }

    const path = PATH_BY_PAGE[page];
    shown.current = page;
    if (path && window.location.pathname !== path) {
      window.history.pushState({ page }, '', path);
      // The design scrolls to the top itself on every page change; doing it
      // here as well would fight it.
    }
  }, [page]);

  useEffect(() => {
    const onPop = () => {
      const path = window.location.pathname.replace(/^\/|\/$/g, '');
      const target = PAGE_BY_PATH[path];
      if (!target) return; // Left the landing entirely; the browser handles it.
      shown.current = target;
      onNavigate(target);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onNavigate]);

  return null;
}
