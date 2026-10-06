'use client';

import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Esc closes the conversation being read (Omer, 2026-10-06: "much like
 * WhatsApp"): `?c=` goes, the rest of the address stays, the pane says to
 * pick one, and focus returns to the row that was open - Enter reopens it.
 *
 * ★ ESC BELONGS TO WHATEVER IS ON TOP FIRST. This never acts while
 *   - a menu, a dialog, Cmd-K or a list box is open (it closes itself);
 *   - something earlier in the event took it (the history drill's Back);
 *   - a field has focus - the composer is blurred, its draft kept, and the
 *     next Esc closes (the draft is saved per conversation; see `Composer`);
 *   - an input method is composing.
 */
const ON_TOP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export function closeTarget(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('c');
  return params.toString();
}

export function InboxEscape({ conversationId }: { readonly conversationId: string }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector(ON_TOP)) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.closest('textarea, input, select, [contenteditable="true"]')
      ) {
        active.blur();
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const rest = closeTarget(window.location.search);
      router.replace((rest ? `${pathname}?${rest}` : pathname) as Route, { scroll: false });
      focusRow(conversationId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conversationId, pathname, router]);

  return null;
}

/** The row that was open, once the page without it has landed (a few frames). */
function focusRow(conversationId: string, tries = 30): void {
  const row = document.querySelector<HTMLElement>(
    `[data-conversation-id="${CSS.escape(conversationId)}"]`,
  );
  if (row && !row.hasAttribute('data-open')) {
    row.focus();
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusRow(conversationId, tries - 1));
  else row?.focus();
}
