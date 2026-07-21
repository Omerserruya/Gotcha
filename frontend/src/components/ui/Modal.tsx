"use client";

/**
 * The ONE modal primitive.
 *
 * Every dialog in GOTCHA should render through this component. It exists
 * because ad-hoc modals kept re-inventing (and getting wrong) four things:
 *
 *  1. **Portal.** A modal rendered inside a scrolling container inherits that
 *     container's scroll and stacking context - the backdrop scrolls with the
 *     page and `position: fixed` stops meaning "the viewport". We portal to
 *     document.body so the backdrop is always viewport-fixed.
 *  2. **Scroll lock that restores position.** `body { overflow: hidden }`
 *     alone lets the page jump to the top on mobile Safari and, when two
 *     modals overlap, the inner one's cleanup unlocks the page while the outer
 *     is still open. We use a REF-COUNTED lock (see `lockScroll`) that pins the
 *     body with `position: fixed` + negative offset and restores the exact
 *     scroll position on the last unlock.
 *  3. **Focus.** Focus is trapped inside the dialog while open (Tab and
 *     Shift+Tab cycle within it) and returned to the element that opened it.
 *  4. **Scroll areas.** The modal body is the only scrollable region; header
 *     and footer stay put. Callers put content in `children` and actions in
 *     `footer` - never their own scroll container.
 *
 * Accessibility: role="dialog" aria-modal, labelled by the title, Escape and
 * backdrop close (both opt-out-able for destructive/blocking dialogs).
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ─── Ref-counted scroll lock ────────────────────────────────
//
// Locking <body> alone is NOT enough here: GOTCHA screens do not scroll on the
// document, each renders inside its own `overflow-y-auto h-screen` container
// (see AppLayout consumers). So we lock BOTH:
//   • every scrollable ancestor of the `anchor` (the element that opened the
//     modal - it lives inside whatever container is actually scrolling), and
//   • the document, for the screens that do scroll on <body>.
// The modal itself is portaled to <body>, so it has no such ancestors to walk;
// the anchor is what tells us which container to freeze.
//
// Ref-counted at module level so stacked modals cooperate: the page unlocks
// only when the LAST modal releases, and the document scroll position is
// captured once and restored exactly.
let lockCount = 0;
let savedScrollY = 0;
let savedBody: { position: string; top: string; width: string; overflowY: string } | null = null;

export function lockScroll(anchor?: HTMLElement | null): () => void {
  const restore: Array<() => void> = [];

  // Per-lock: freeze the scrollable ancestors this modal was opened from.
  // Only `overflowY` is touched so horizontal scrolling is left alone, and no
  // scroll offset is written, so container positions are preserved for free.
  for (let el = anchor?.parentElement ?? null; el; el = el.parentElement) {
    const { overflowY } = window.getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") {
      const prev = el.style.overflowY;
      const target = el;
      target.style.overflowY = "hidden";
      restore.push(() => { target.style.overflowY = prev; });
    }
  }

  // Shared: pin the document (only the outermost lock does this).
  if (lockCount === 0) {
    savedScrollY = window.scrollY;
    const b = document.body.style;
    savedBody = { position: b.position, top: b.top, width: b.width, overflowY: b.overflowY };
    // position:fixed pins the page without the iOS "jump to top" that plain
    // overflow:hidden causes; the negative top keeps the current view in place.
    b.position = "fixed";
    b.top = `-${savedScrollY}px`;
    b.width = "100%";
    b.overflowY = "scroll"; // keep the scrollbar gutter - no horizontal shift
  }
  lockCount += 1;

  let released = false;
  return () => {
    if (released) return; // double-cleanup (StrictMode) must not unbalance the count
    released = true;
    restore.forEach((fn) => fn());
    lockCount -= 1;
    if (lockCount > 0) return;
    const b = document.body.style;
    b.position = savedBody?.position ?? "";
    b.top = savedBody?.top ?? "";
    b.width = savedBody?.width ?? "";
    b.overflowY = savedBody?.overflowY ?? "";
    savedBody = null;
    // Restore the exact position the user was reading before opening.
    window.scrollTo(0, savedScrollY);
  };
}

/** Test seam: assert the lock is balanced. */
export function __scrollLockDepth(): number {
  return lockCount;
}

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** Optional line under the title. */
  subtitle?: React.ReactNode;
  /** Action row pinned below the scrolling body (buttons live here). */
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** Tailwind max-width class for the panel. Default: max-w-2xl. */
  maxWidth?: string;
  /** Escape closes. Default true - set false for blocking flows. */
  closeOnEscape?: boolean;
  /** Clicking the backdrop closes. Default true. */
  closeOnBackdrop?: boolean;
  /** Hide the × button (e.g. a gate the user must complete). */
  hideCloseButton?: boolean;
  dir?: "ltr" | "rtl";
  /** Applied to the panel - lets a caller tag it for tests. */
  "data-testid"?: string;
}

export function Modal({
  open, onClose, title, subtitle, footer, children,
  maxWidth = "max-w-2xl", closeOnEscape = true, closeOnBackdrop = true,
  hideCloseButton = false, dir, ...rest
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // Portals need the DOM; render nothing during SSR/first paint.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Scroll lock + focus save/restore, tied to `open`.
  useEffect(() => {
    if (!open) return;
    // Captured BEFORE the focus effect below moves focus into the dialog, so
    // this is genuinely the trigger element - it doubles as the scroll-lock
    // anchor (it lives inside the container that is actually scrolling).
    restoreFocusRef.current = (document.activeElement as HTMLElement) || null;
    const release = lockScroll(restoreFocusRef.current);
    return () => {
      release();
      // Return focus to whatever opened the modal (the trigger button), so
      // keyboard users resume where they were instead of at document start.
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  // Move focus INTO the dialog once it renders.
  useEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus({ preventScroll: true });
  }, [open, mounted]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" && closeOnEscape) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // Focus trap: cycle within the panel instead of escaping to the page behind.
    const panel = panelRef.current;
    if (!panel) return;
    // `checkVisibility` where the engine supports it; otherwise take every
    // match. (Do NOT filter on `offsetParent` - it is null for everything in
    // jsdom and under `position: fixed`, which would collapse the trap to a
    // single element.)
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => (typeof el.checkVisibility === "function" ? el.checkVisibility() : true));
    if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, [closeOnEscape, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start sm:items-center justify-center overflow-hidden bg-gray-900/60 p-0 sm:p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}
      onKeyDown={onKeyDown}
      dir={dir}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // The panel is a flex COLUMN capped to the viewport: header and footer
        // are fixed rows, only the middle scrolls (see the body div below).
        className={`flex w-full ${maxWidth} max-h-[100dvh] sm:max-h-[90vh] flex-col overflow-hidden rounded-none sm:rounded-2xl bg-white shadow-2xl outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
        {...rest}
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4 shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-gray-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
          </div>
          {!hideCloseButton && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* The ONLY scrollable region. `overscroll-contain` stops scroll
            chaining to the (locked) page when the content hits its end. */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4" data-modal-body>
          {children}
        </div>

        {footer && (
          <div className="shrink-0 border-t border-gray-100 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
