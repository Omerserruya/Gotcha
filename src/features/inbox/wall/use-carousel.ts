'use client';

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { useDirection } from '@/i18n/direction-context';

import { stepTo } from './wall-model';

/** A horizontal drag this long is a swipe; shorter is a click that wobbled. */
export const SWIPE_PX = 40;

/**
 * One carousel's position, and the three ways to move it: the ‹ › buttons
 * (`go`), the arrow keys and a swipe (`region`, spread on the element).
 *
 * ★ "Next" IS THE READING DIRECTION'S. In Hebrew the next card is to the
 *   left, so → goes back and a swipe to the right goes forward.
 */
export function useCarousel(count: number, start = 0) {
  const direction = useDirection();
  const [index, setIndex] = useState(start);
  const from = useRef<number | null>(null);
  const at = stepTo(index, 0, count);
  const go = (delta: number) => setIndex((i) => stepTo(i, delta, count));
  const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const back = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';

  const region = {
    tabIndex: 0,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      // The keys belong to a field when somebody is typing in one.
      if ((event.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
      if (event.key === forward) go(1);
      else if (event.key === back) go(-1);
      else return;
      event.preventDefault();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      from.current = event.clientX;
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (from.current === null) return;
      const dx = event.clientX - from.current;
      from.current = null;
      if (Math.abs(dx) < SWIPE_PX) return;
      // A leftward drag pulls the next card in from the right — in LTR.
      go(dx < 0 === (direction === 'ltr') ? 1 : -1);
    },
  };

  return { index: at, go, region, first: at === 0, last: at >= count - 1 };
}
