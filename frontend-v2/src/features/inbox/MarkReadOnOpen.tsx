'use client';

import { useEffect, useRef } from 'react';

import { markReadOnOpen } from './conversation-actions';

/**
 * Opening a conversation marks it read for the person opening it. Renders
 * nothing.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONCE PER OPEN, NOT PER RENDER
 * ════════════════════════════════════════════════════════════════════════════
 * The page re-renders while a conversation stays open - after a verb, after
 * this call's own refresh, and on every live refresh of the list. None of
 * those is an open. The ref remembers which id was marked, so the same id is
 * never sent twice in a row; another id is a new open, and coming back to the
 * first one after it (or after Esc) is a new open too.
 *
 * ⚠ AND NOT AGAIN WHEN THE ROW TURNS UNREAD WHILE OPEN. "Mark as unread" on
 *   the open row is the person asking for exactly that; re-marking it read on
 *   the next render would undo their click.
 *
 * ★ A client effect rather than the page's render: the render is a GET, and
 *   a GET that writes runs again on every prefetch and refresh.
 *
 * ★★ NOTHING SENT FOR A ROW ALREADY READ (dev, 2026-10-11). Every send is
 *   answered with this person's own `conversation:updated`, and every one of
 *   those re-renders the inbox - so opening a read conversation re-rendered
 *   the page about a second later, invalidating every prefetched route. A row
 *   that says `unread: false` has nothing to clear. A row whose read state is
 *   unknown (opened by id, which carries none) is still sent - but without a
 *   refresh of our own: the echo is the refresh.
 */
export function MarkReadOnOpen({
  conversationId,
  readState,
}: {
  readonly conversationId: string;
  /**
   * The open row's read state as the server gave it: `unread` (drawn with a
   * mark - send, and refresh so it loses it), `read` (`unread: false` -
   * nothing to send), `unknown` (no read fields - send, no refresh).
   */
  readonly readState: 'unread' | 'read' | 'unknown';
}) {
  const marked = useRef<string | null>(null);

  useEffect(() => {
    if (marked.current === conversationId) return;
    marked.current = conversationId;
    if (readState === 'read') return;
    /*
     * Silent: the action logs its own failure and never throws. The catch is
     * for the transport to our own server, which is no more the reader's
     * problem than the platform's answer is.
     */
    markReadOnOpen(conversationId, readState === 'unread').catch(() => undefined);
  }, [conversationId, readState]);

  return null;
}
