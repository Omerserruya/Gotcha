'use client';

import { useEffect } from 'react';

import { STREAM_SCROLLER } from './stream-scroller';

/**
 * Opens a conversation at its LATEST message, and keeps it there.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ A CONVERSATION OPENED AT ITS OLDEST MESSAGE
 * ════════════════════════════════════════════════════════════════════════════
 * Measured on the deployed build: the stream's scroller at `scrollTop 0` of a
 * possible 2142. The reader saw 10:03 and the message they had come to answer
 * was 2142px below - in a column whose reply box sits at the bottom.
 *
 * ── PINNED ONLY WHILE THE READER IS AT THE BOTTOM ──
 * A new message, or the composer growing, keeps the latest message in view -
 * unless the reader has scrolled up to read something, in which case moving
 * them would take away what they were reading. "At the bottom" has a little
 * slack, because a sub-pixel `scrollTop` never reaches the exact end.
 *
 * Renders nothing. A sibling of `MessageStream`, not its parent: that is an
 * async server component, and the scroller is its own `<ol>`, found by
 * `data-stream-scroller`.
 */

/** How far from the end still counts as "at the end". */
const SLACK_PX = 48;

export function StreamPin({ conversationId }: { readonly conversationId: string }) {
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(`[${STREAM_SCROLLER}]`);
    if (!scroller) return;

    let pinned = true;
    const toEnd = () => {
      scroller.scrollTop = scroller.scrollHeight;
    };
    const onScroll = () => {
      pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= SLACK_PX;
    };

    toEnd();
    scroller.addEventListener('scroll', onScroll, { passive: true });

    // A message arriving, or the stream re-read after a send.
    const added = new MutationObserver(() => {
      if (pinned) toEnd();
    });
    added.observe(scroller, { childList: true, subtree: true });

    // The window shrinking - the composer grows as somebody types.
    const resized =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (pinned) toEnd();
          });
    resized?.observe(scroller);

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      added.disconnect();
      resized?.disconnect();
    };
    // ★ Per conversation: opening another one starts at ITS latest message.
  }, [conversationId]);

  return null;
}
