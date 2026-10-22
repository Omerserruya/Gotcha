import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ 04's search is live (Omer, 2026-10-07): a pause in typing searches; Enter
 * searches at once; the URL is replaced, never pushed; an empty field is the
 * whole list; and only the newest text is ever asked for.
 */
const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  query: '',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => '/he/customers',
  useSearchParams: () => new URLSearchParams(nav.query),
}));

const { CustomerSearch, SEARCH_DEBOUNCE_MS } = await import('./CustomerSearch');

const show = (query = '') =>
  render(
    <CustomerSearch query={query} label="Search" placeholder="Search" busyLabel="Searching" />,
  );
const type = (text: string) =>
  fireEvent.change(screen.getByTestId('customer-search-input'), { target: { value: text } });

beforeEach(() => {
  vi.useFakeTimers();
  nav.replace.mockReset();
  nav.push.mockReset();
  nav.query = 'segment=talking';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('★★ live search', () => {
  it('typing without Enter searches after the pause - replaced, the rest of the URL kept', () => {
    show();
    type('dana');
    expect(nav.replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('/he/customers?segment=talking&q=dana', {
      scroll: false,
    });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('★ a run of keystrokes asks once, for the newest text only', () => {
    show();
    for (const text of ['a', 'ab', 'abc']) {
      type(text);
      act(() => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50);
      });
    }
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace.mock.calls[0]![0]).toContain('q=abc');
  });

  it('Enter searches at once, and the pause does not ask again', () => {
    show();
    type('054');
    fireEvent.submit(screen.getByTestId('customer-search'));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it('an empty field is the whole list: q goes, the rest stays', () => {
    nav.query = 'segment=talking&q=dana';
    show('dana');
    type('');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(nav.replace).toHaveBeenCalledWith('/he/customers?segment=talking', { scroll: false });
  });

  it('the same text as the URL asks nothing', () => {
    nav.query = 'q=dana';
    show('dana');
    type('dana ');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('Hebrew and a phone, as typed; the field reads its own direction', () => {
    show();
    expect(screen.getByTestId('customer-search-input')).toHaveAttribute('dir', 'auto');
    type('דנה 054-1234567');
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    const url = new URL(nav.replace.mock.calls[0]![0] as string, 'https://x');
    expect(url.searchParams.get('q')).toBe('דנה 054-1234567');
  });
});
