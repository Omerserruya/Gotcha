"use client";

import { RefObject, useEffect } from "react";
import { lockScroll } from "@/components/ui/Modal";

/**
 * Freeze the page behind an open overlay.
 *
 * THIN WRAPPER: the real implementation is `lockScroll` in components/ui/Modal
 * so there is exactly ONE lock in the app. That matters because the lock is
 * ref-counted - two independent implementations cannot see each other's depth,
 * so an inner overlay closing would unfreeze the page while an outer one is
 * still open.
 *
 * Prefer `<Modal>` for anything new; this hook remains for overlays that are
 * not full dialogs (drawers, inline expanders) and cannot adopt it yet.
 *
 * Locking `document.body` alone is not enough here: screens do not scroll on
 * <body>, each renders inside its own `overflow-y-auto h-screen` container, so
 * `lockScroll` walks up from the passed node and freezes the scrollable
 * ancestors it is actually rendered inside.
 *
 * @param ref    the overlay element (must be rendered when `active`)
 * @param active whether the overlay is currently open
 */
export function useScrollLock(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    return lockScroll(node);
  }, [ref, active]);
}
