'use client';

import { useEffect } from 'react';

/**
 * Brings one section of the page into view and gives it focus, once, on
 * arrival - for an address that names it (`/studio/knowledge?section=gaps`,
 * which the assistant links to). Renders nothing.
 */
export function FocusSection({ testid }: { readonly testid: string }) {
  useEffect(() => {
    const section = [...document.querySelectorAll<HTMLElement>('[data-testid]')].find(
      (el) => el.dataset.testid === testid,
    );
    section?.scrollIntoView?.({ block: 'start' });
    section?.focus({ preventScroll: true });
  }, [testid]);
  return null;
}
