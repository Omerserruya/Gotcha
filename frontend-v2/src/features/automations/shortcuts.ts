/**
 * Keyboard shortcuts on 09c and 09d (Omer, 2026-10-07). Shared rules, so
 * the list and the canvas behave alike:
 *
 *   - never while typing (a field, a text area, anything editable);
 *   - never under something on top (a dialog, a menu, a list box) - it
 *     owns the keyboard while it is open;
 *   - ⌘ on a Mac, Ctrl elsewhere - either is accepted, so a person on a
 *     Mac with a PC keyboard is not stuck.
 */
const ON_TOP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export function typingIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  );
}

/** Whether a shortcut may act on this key press at all. */
export function shortcutsAllowed(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (typingIn(event.target)) return false;
  return document.querySelector(ON_TOP) === null;
}

/** ⌘ or Ctrl held. */
export function withMod(event: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

/** "⌘" on a Mac, "Ctrl" elsewhere - for the words, not for the check. */
export function modLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}
