'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A sheet or drawer the URL opens (`?add=1`, `?hire=1`, `?panel=…`) behaves
 * as the Radix dialogs do (supervisor, measured on dev: Escape did nothing):
 * focus moves into it, Tab and Shift+Tab stay inside it, Escape closes it,
 * and whatever closes it - Escape, ×, the scrim - focus goes back to what
 * opened it.
 *
 * Closing is the caller's navigation (`onEscape`): the sheet is unmounted by
 * the render without the query, and that unmount is when focus returns, so
 * every way out takes the same path.
 *
 * What opened it is what had focus when it mounted - the row or button a
 * click or Enter left focused, kept across the soft navigation. When that is
 * gone (a sheet opened by a redirect, or a Safari click that focuses
 * nothing), `openerId` names the page's own control instead.
 *
 * ⚠ Radix's own Escape (a menu, Ctrl K) is `preventDefault`-ed in capture,
 *   so a layer over the sheet closes alone.
 */
export function useSheetFocus(
  sheet: RefObject<HTMLElement | null>,
  {
    onEscape,
    openerId,
  }: {
    readonly onEscape: () => void;
    /** The page's control that opens it, by id - when focus came from nowhere. */
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
    const before = document.activeElement;
    const opener =
      before instanceof HTMLElement && before !== document.body && !node.contains(before)
        ? before
        : null;
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
      const back = opener?.isConnected
        ? opener
        : openerId
          ? document.getElementById(openerId)
          : null;
      back?.focus();
    };
  }, [sheet, openerId]);
}

/**
 * Escape as a press on the sheet's own × (marked `data-sheet-close`): the
 * same navigation, with its own `href` and `scroll`, so the two cannot drift.
 */
export function pressSheetClose(sheet: HTMLElement | null) {
  sheet?.querySelector<HTMLElement>('[data-sheet-close]')?.click();
}
