'use client';

import { useEffect } from 'react';

/** How close to the end counts as the end, in px. */
const AT_END = 4;

/**
 * ★★ A WINDOW THAT HAS MORE SAYS SO (Omer on a 14", 2026-10-07).
 *
 * On a Mac the scrollbar is hidden until you scroll, so a card that scrolls
 * inside itself looked cut in half - a row through the middle, no hint of
 * more. Every scroll window in the product (any element whose `overflow-y`
 * is `auto` or `scroll`, found by looking, not by a list someone keeps)
 * carries `data-more` while there is content below its edge; the global
 * stylesheet fades that edge. Scrolled to the end, the fade goes.
 *
 * Draws nothing. One per app shell.
 */
export function ScrollFades() {
  useEffect(() => {
    const known = new Set<HTMLElement>();

    const update = (el: HTMLElement) => {
      const more = el.scrollHeight - el.scrollTop - el.clientHeight > AT_END;
      if (more) el.setAttribute('data-more', '');
      else el.removeAttribute('data-more');
    };

    /** Note the scroll windows in a subtree - the page at first, then what is added. */
    const scan = (root: Element) => {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (!(el instanceof HTMLElement) || known.has(el)) continue;
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') known.add(el);
      }
    };

    const updateAll = () => {
      for (const el of known) {
        if (el.isConnected) update(el);
        else known.delete(el);
      }
    };

    let frame = 0;
    const added: Element[] = [];
    const soon = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const root of added.splice(0)) if (root.isConnected) scan(root);
        updateAll();
      });
    };

    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && known.has(event.target)) update(event.target);
    };

    scan(document.body);
    updateAll();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // A resize can turn a box into a window (Home's height breakpoint): look again.
    const onResize = () => {
      added.push(document.body);
      soon();
    };
    window.addEventListener('resize', onResize);
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) added.push(node);
      }
      soon();
    });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      watch.disconnect();
      for (const el of known) el.removeAttribute('data-more');
    };
  }, []);

  return null;
}
