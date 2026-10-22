'use client';

import { useEffect } from 'react';

import rowLink from '@/design-system/styles/row-link.module.css';

/**
 * ★★ THE WHOLE ROW IS CLICKABLE, CHIPS INCLUDED (supervisor, 2026-10-11).
 *
 * A chip that explains itself only on hover sits above its row's stretched
 * link (`rowLink.tip`) so the tooltip can show - which made it the one dead
 * spot on a clickable row. One listener for the whole of Settings forwards a
 * click on such a chip to its row's link, with the same modifier keys, so
 * Ctrl or Cmd still opens it in a new tab. The chip gains no tab stop.
 */
export function RowTipForward() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const tip = target?.closest(`.${rowLink.tip}`);
      const link = tip?.closest(`.${rowLink.row}`)?.querySelector<HTMLElement>(`.${rowLink.link}`);
      if (!link) return;
      event.preventDefault();
      link.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        }),
      );
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  return null;
}
