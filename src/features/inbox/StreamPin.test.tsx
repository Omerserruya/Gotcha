import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StreamPin } from './StreamPin';
import { STREAM_SCROLLER } from './stream-scroller';

/*
 * jsdom has no layout, so the scroller's geometry is set by hand: 2757 of
 * content in a 615 window — the deployed conversation that opened at 10:03.
 */
const scroller = (scrollHeight = 2757, clientHeight = 615) => {
  const el = document.createElement('ol');
  el.setAttribute(STREAM_SCROLLER, '');
  let height = scrollHeight;
  Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  document.body.appendChild(el);
  return { el, grow: (by: number) => (height += by) };
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('⚠⚠ a conversation opens at its LATEST message', () => {
  it('★★ scrolls to the end on open — it sat at 0 of 2142', () => {
    const { el } = scroller();
    render(<StreamPin conversationId="c1" />);
    expect(el.scrollTop).toBe(2757);
  });

  it('★ a new message keeps the reader at the end, when they were there', async () => {
    const { el, grow } = scroller();
    render(<StreamPin conversationId="c1" />);
    grow(80);
    await act(async () => {
      el.appendChild(document.createElement('li'));
      await Promise.resolve();
    });
    expect(el.scrollTop).toBe(2837);
  });

  it('⚠⚠ but does NOT pull a reader down who scrolled up to read', async () => {
    const { el, grow } = scroller();
    render(<StreamPin conversationId="c1" />);
    el.scrollTop = 400;
    el.dispatchEvent(new Event('scroll'));
    grow(80);
    await act(async () => {
      el.appendChild(document.createElement('li'));
      await Promise.resolve();
    });
    expect(el.scrollTop).toBe(400);
  });
});
