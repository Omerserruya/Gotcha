import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScrollFades } from './ScrollFades';

/**
 * ★★ A scroll window with more below says so (Omer on a 14", 2026-10-07):
 * `data-more` while content runs past its edge - found by looking, for every
 * window, not by a list - and gone at the end. jsdom has no layout, so the
 * sizes are set by hand.
 */
function scroller(content: number, box: number, top = 0): HTMLDivElement {
  const el = document.createElement('div');
  el.style.overflowY = 'auto';
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => content });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box });
  el.scrollTop = top;
  let scrolled = top;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrolled,
    set: (v: number) => {
      scrolled = v;
    },
  });
  return el;
}

const frame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('★★ ScrollFades', () => {
  it('more below: marked; scrolled to the end: not', () => {
    const list = scroller(600, 300);
    document.body.appendChild(list);
    render(<ScrollFades />);
    expect(list.hasAttribute('data-more')).toBe(true);
    list.scrollTop = 300;
    act(() => {
      list.dispatchEvent(new Event('scroll'));
    });
    expect(list.hasAttribute('data-more')).toBe(false);
  });

  it('all of it showing: never marked - a fade that promises nothing is a lie too', () => {
    const fits = scroller(200, 300);
    document.body.appendChild(fits);
    render(<ScrollFades />);
    expect(fits.hasAttribute('data-more')).toBe(false);
  });

  it('a box that does not scroll is never touched, however tall its content', () => {
    const plain = scroller(600, 300);
    plain.style.overflowY = 'visible';
    document.body.appendChild(plain);
    render(<ScrollFades />);
    expect(plain.hasAttribute('data-more')).toBe(false);
  });

  it('a window that arrives later (a streamed section) is found and marked', async () => {
    render(<ScrollFades />);
    const late = scroller(900, 300);
    act(() => {
      document.body.appendChild(late);
    });
    await frame();
    expect(late.hasAttribute('data-more')).toBe(true);
  });
});
