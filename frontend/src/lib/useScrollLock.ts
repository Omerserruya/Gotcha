"use client";

import { RefObject, useEffect } from "react";

/**
 * Freeze the page behind an open overlay.
 *
 * Locking `document.body` is NOT enough in this app: screens do not scroll on
 * <body>, each one renders inside its own `overflow-y-auto h-screen` container
 * (see AppLayout consumers). Setting body overflow there does nothing, so the
 * backdrop kept scrolling under the modal and the page was left at a random
 * offset once it closed.
 *
 * So: walk up from the overlay's own node and lock every scrollable ancestor we
 * are actually rendered inside, whatever they happen to be. That keeps this
 * correct without hard-coding a selector for today's layout classes.
 *
 * Only `overflowY` is touched (not `overflow`) so a container's horizontal
 * scrolling is left alone. Scroll offsets are never written, so positions are
 * preserved for free and restored when the lock lifts.
 *
 * @param ref  the overlay element (must be rendered when `active`)
 * @param active whether the overlay is currently open
 */
export function useScrollLock(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    const restore: Array<() => void> = [];

    for (let el = node.parentElement; el; el = el.parentElement) {
      const { overflowY } = window.getComputedStyle(el);
      if (overflowY === "auto" || overflowY === "scroll") {
        const prev = el.style.overflowY;
        el.style.overflowY = "hidden";
        restore.push(() => { el.style.overflowY = prev; });
      }
    }

    // Belt and braces for any screen that DOES scroll on the document itself.
    const prevBody = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    restore.push(() => { document.body.style.overflow = prevBody; });

    return () => restore.forEach((fn) => fn());
  }, [ref, active]);
}
