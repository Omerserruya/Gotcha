'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A sheet the URL opens (08b's `?add=1`) behaves as the other dialogs do
 * (supervisor, measured on dev: Escape did nothing): focus moves into it,
 * Tab and Shift+Tab stay inside it, Escape closes it, and whatever closes it
 * - Escape, ×, the scrim - focus goes back to what opened it.
 *
 * Closing is the caller's navigation (`onEscape`): the sheet is unmounted by
 * the render without the query, and that unmount is when focus returns, so
 * every way out takes the same path.
 */
export function useSheetFocus(
  sheet: RefObject<HTMLElement | null>,
  {
    onEscape,
    openerId,
  }: {
    readonly onEscape: () => void;
    /** The element that opened it, by id - the page's own control. */
    readonly openerId?: string;
  },
) {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const node = sheet.current;
    if (!node) return;
    if (!node.contains(document.activeElement)) node.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (!node) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const all = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (all.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = all[0]!;
      const last = all.at(-1)!;
      const active = document.activeElement;
      if (!node.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (openerId) document.getElementById(openerId)?.focus();
    };
  }, [sheet, openerId]);
}
