'use client';

import { Reply } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { replyTo, type ReplyTarget } from './reply-event';
import styles from './Inbox.module.css';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ SWIPE A MESSAGE TO REPLY TO IT (Omer, 2026-11-24, the phone)
 * ════════════════════════════════════════════════════════════════════════════
 * WhatsApp's gesture: a short drag of the message away from the side it
 * starts on, and letting go past the threshold quotes it in the composer -
 * the same `replyTo` the website's Reply button sends, so the composer shows
 * the same quote (who, the first line, an X) and the send carries
 * `replyToMessageId`, which WhatsApp delivers as a real quoted reply.
 *
 * ★ The direction is the page's reading direction, as WhatsApp mirrors it:
 *   right in English, LEFT in Hebrew (toward the end of the line). Rows on
 *   the list swipe by the hand (RowDelete); a message is a line of text.
 * ★ Placed inside the message's `<li>` and drives that element: the whole
 *   message moves, the icon appears in the space it leaves.
 * ★ Touch only. A mouse keeps the hover bar's Reply (the website).
 * ★ Never steals a horizontal scroll (a row of product cards) or a vertical
 *   one (the stream), and a swipe is never also a tap on a photo.
 */

/** How far the message must travel before letting go replies. */
export const REPLY_THRESHOLD = 56;
const REPLY_MAX = 72;
const ICON = 18;

function scrollsSideways(from: Element | null, stop: Element): boolean {
  for (let node = from; node && node !== stop; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth) {
      return true;
    }
  }
  return false;
}

export function SwipeReply({ target }: { readonly target: ReplyTarget }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [progress, setProgress] = useState(0);
  // The latest target without re-binding the listeners on every render.
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    const message = anchor.current?.parentElement;
    if (!message) return;
    message.style.touchAction = 'pan-y';
    let start: { x: number; y: number; id: number } | null = null;
    let moved = false;
    let travel = 0;

    const set = (value: number) => {
      travel = value;
      message.style.transform = value ? `translateX(${value}px)` : '';
      if (value) message.dataset.swiping = '';
      else delete message.dataset.swiping;
      setProgress(Math.abs(value));
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      if (scrollsSideways(event.target as Element, message)) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      moved = false;
    };
    const move = (event: PointerEvent) => {
      if (!start || start.id !== event.pointerId) return;
      const x = event.clientX - start.x;
      const y = event.clientY - start.y;
      // A vertical gesture is the stream scrolling: let it go.
      if (!moved && Math.abs(y) > Math.abs(x)) {
        start = null;
        return;
      }
      // Toward the end of the line: right in LTR, left in RTL.
      const sign = getComputedStyle(message).direction === 'rtl' ? -1 : 1;
      const along = Math.max(0, Math.min(REPLY_MAX, x * sign));
      if (along > 6) moved = true;
      set(along * sign);
    };
    const up = () => {
      const far = Math.abs(travel) >= REPLY_THRESHOLD;
      start = null;
      set(0);
      if (far) replyTo(targetRef.current);
    };
    const click = (event: MouseEvent) => {
      // A swipe is not a tap: it never also opens a photo or a link.
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
        moved = false;
      }
    };

    message.addEventListener('pointerdown', down);
    message.addEventListener('pointermove', move);
    message.addEventListener('pointerup', up);
    message.addEventListener('pointercancel', up);
    message.addEventListener('click', click, true);
    return () => {
      message.removeEventListener('pointerdown', down);
      message.removeEventListener('pointermove', move);
      message.removeEventListener('pointerup', up);
      message.removeEventListener('pointercancel', up);
      message.removeEventListener('click', click, true);
      message.style.transform = '';
      message.style.touchAction = '';
    };
  }, []);

  /*
   * The icon sits in the middle of the space the message has left, and only
   * once that space can hold it (ICON px): drawn earlier it would stick out
   * past the screen's edge.
   */
  const shown = progress >= ICON;
  return (
    <span
      ref={anchor}
      className={styles.swipeReply}
      aria-hidden="true"
      data-testid={`swipe-reply-${target.id}`}
      data-ready={progress >= REPLY_THRESHOLD ? '' : undefined}
      style={
        shown
          ? {
              insetInlineStart: `${-(progress + ICON) / 2}px`,
              opacity: Math.min(1, progress / REPLY_THRESHOLD),
            }
          : undefined
      }
    >
      {shown ? <Reply size={ICON} /> : null}
    </span>
  );
}
