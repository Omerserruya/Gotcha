import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPLY_TO_EVENT, type ReplyTarget } from './reply-event';
import { REPLY_THRESHOLD, SwipeReply } from './SwipeReply';

const TARGET: ReplyTarget = { id: 'm1', who: 'לקוח', preview: 'שלום, יש במלאי?' };

let replies: ReplyTarget[] = [];
const onReply = (event: Event) => replies.push((event as CustomEvent<ReplyTarget>).detail);

beforeEach(() => {
  replies = [];
  window.addEventListener(REPLY_TO_EVENT, onReply);
});
afterEach(() => {
  window.removeEventListener(REPLY_TO_EVENT, onReply);
});

const show = (dir: 'ltr' | 'rtl', extra: React.ReactNode = null) =>
  render(
    <ol dir={dir}>
      <li data-testid="message" style={{ direction: dir }}>
        <p data-testid="bubble">שלום, יש במלאי?</p>
        {extra}
        <SwipeReply target={TARGET} />
      </li>
    </ol>,
  );

const drag = (from: Element, dx: number, dy = 0, pointerType = 'touch') => {
  const message = screen.getByTestId('message');
  fireEvent.pointerDown(from, { pointerType, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(message, {
    pointerType,
    pointerId: 1,
    clientX: 100 + dx,
    clientY: 100 + dy,
  });
  fireEvent.pointerUp(message, { pointerType, pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
};

describe('★★ swipe a message to reply (2026-11-24)', () => {
  it('★★ Hebrew: a swipe LEFT past the threshold quotes it in the composer', () => {
    show('rtl');
    drag(screen.getByTestId('bubble'), -(REPLY_THRESHOLD + 5));
    expect(replies).toEqual([TARGET]);
  });

  it('★★ English: a swipe RIGHT', () => {
    show('ltr');
    drag(screen.getByTestId('bubble'), REPLY_THRESHOLD + 5);
    expect(replies).toEqual([TARGET]);
  });

  it('⚠⚠ the other way does nothing (Hebrew, right)', () => {
    show('rtl');
    drag(screen.getByTestId('bubble'), REPLY_THRESHOLD + 30);
    expect(replies).toEqual([]);
  });

  it('⚠⚠ short of the threshold: nothing', () => {
    show('rtl');
    drag(screen.getByTestId('bubble'), -(REPLY_THRESHOLD - 10));
    expect(replies).toEqual([]);
  });

  it('⚠⚠ a vertical gesture is the stream scrolling', () => {
    show('rtl');
    drag(screen.getByTestId('bubble'), -(REPLY_THRESHOLD + 5), 200);
    expect(replies).toEqual([]);
  });

  it('⚠⚠ a mouse keeps the hover bar: no swipe', () => {
    show('rtl');
    drag(screen.getByTestId('bubble'), -(REPLY_THRESHOLD + 5), 0, 'mouse');
    expect(replies).toEqual([]);
  });

  it('★ the message follows the finger, and comes back when let go', () => {
    show('rtl');
    const message = screen.getByTestId('message');
    fireEvent.pointerDown(message, {
      pointerType: 'touch',
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(message, {
      pointerType: 'touch',
      pointerId: 1,
      clientX: 60,
      clientY: 100,
    });
    expect(message.style.transform).toBe('translateX(-40px)');
    expect(screen.getByTestId('swipe-reply-m1').querySelector('svg')).not.toBeNull();
    fireEvent.pointerUp(message, { pointerType: 'touch', pointerId: 1, clientX: 60, clientY: 100 });
    expect(message.style.transform).toBe('');
    expect(screen.getByTestId('swipe-reply-m1').querySelector('svg')).toBeNull();
  });

  it('⚠⚠ never steals a sideways scroll (a row of product cards)', () => {
    const row = (
      <div data-testid="cards" style={{ overflowX: 'auto' }}>
        <span data-testid="card">card</span>
      </div>
    );
    show('rtl', row);
    const cards = screen.getByTestId('cards');
    Object.defineProperty(cards, 'scrollWidth', { value: 600 });
    Object.defineProperty(cards, 'clientWidth', { value: 200 });
    drag(screen.getByTestId('card'), -(REPLY_THRESHOLD + 5));
    expect(replies).toEqual([]);
  });

  it('★ a swipe is not a tap: the photo under it does not open', () => {
    const opened = vi.fn();
    show('rtl', <button type="button" data-testid="photo" onClick={opened} />);
    const photo = screen.getByTestId('photo');
    drag(photo, -(REPLY_THRESHOLD + 5));
    fireEvent.click(photo);
    expect(opened).not.toHaveBeenCalled();
    // The next tap is a tap.
    fireEvent.click(photo);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
