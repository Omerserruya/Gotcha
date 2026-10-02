import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));

let search = 'c=c1';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));

import { PendingPane } from './PendingPane';
import { clearPendingOpen } from './pending-open';
import { QueueRowLink } from './QueueRowLink';

/*
 * ★★ OMER: "I WANT IT TO FEEL INSTANT." A row is a link, and the screen used
 *    to do nothing until the server answered. These are the click's own answer.
 */
const rows = (openId: string | null) => (
  <>
    {['c1', 'c2'].map((id) => (
      <QueueRowLink
        key={id}
        href={{ pathname: '/inbox', query: { c: id } }}
        data-testid={`row-${id}`}
        open={id === openId}
        pending={{ id, name: id === 'c2' ? 'Dana Cohen' : 'Yael', channelLabel: 'WhatsApp' }}
      >
        {id}
      </QueueRowLink>
    ))}
    <PendingPane openId={openId} />
  </>
);

/*
 * jsdom does not navigate on an anchor click, so a plain click is the user's
 * click. (Preventing default here would be wrong: `QueueRowLink` ignores an
 * already-handled click, and in the app Next's Link runs our handler first.)
 */
const click = (el: HTMLElement, init: MouseEventInit = {}) =>
  fireEvent.click(el, { button: 0, ...init });

afterEach(() => {
  act(() => clearPendingOpen());
  search = 'c=c1';
});

describe('★★ the click is answered before the server is', () => {
  it('★★ the clicked row is marked at once, and the open one lets go', () => {
    render(rows('c1'));
    expect(screen.getByTestId('row-c1')).toHaveAttribute('aria-current', 'true');
    click(screen.getByTestId('row-c2'));
    expect(screen.getByTestId('row-c2')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('row-c2')).toHaveAttribute('data-open');
    expect(screen.getByTestId('row-c1')).not.toHaveAttribute('aria-current');
  });

  it('★★ the pane shows who it is, and placeholders for the rest', () => {
    render(rows('c1'));
    click(screen.getByTestId('row-c2'));
    const pane = screen.getByTestId('pending-pane');
    expect(pane).toHaveTextContent('Dana Cohen');
    expect(pane).toHaveTextContent('WhatsApp');
    expect(screen.getByTestId('stream-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('composer-skeleton')).toBeInTheDocument();
  });

  it('★ and both give way when the server’s answer lands', () => {
    const { rerender } = render(rows('c1'));
    click(screen.getByTestId('row-c2'));
    rerender(rows('c2'));
    expect(screen.queryByTestId('pending-pane')).toBeNull();
    expect(screen.getByTestId('row-c2')).toHaveAttribute('aria-current', 'true');
  });

  it('⚠ a click that opens a new tab marks nothing — this tab is not going anywhere', () => {
    render(rows('c1'));
    click(screen.getByTestId('row-c2'), { metaKey: true });
    expect(screen.getByTestId('row-c1')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByTestId('pending-pane')).toBeNull();
  });

  it('⚠ clicking the row that is already open changes nothing', () => {
    render(rows('c1'));
    click(screen.getByTestId('row-c1'));
    expect(screen.queryByTestId('pending-pane')).toBeNull();
  });
});

describe('⚠⚠ the overlay clears when the URL lands — not only when the open conversation changes', () => {
  it('★★ the clicked conversation is gone, the first row opens again: the overlay still goes', () => {
    const { rerender } = render(rows('c1'));
    click(screen.getByTestId('row-c2'));
    expect(screen.getByTestId('pending-pane')).toBeInTheDocument();
    // The server answered `?c=c2` with c1 open: `openId` is unchanged.
    search = 'c=c2';
    rerender(rows('c1'));
    expect(screen.queryByTestId('pending-pane')).toBeNull();
    expect(screen.getByTestId('row-c1')).toHaveAttribute('aria-current', 'true');
  });
});

describe('★★ shift-click picks the row, and opens nothing', () => {
  it('toggles it into the selection without marking it open', async () => {
    const { currentSelection, clearSelected } = await import('./queue-selection');
    render(rows('c1'));
    click(screen.getByTestId('row-c2'), { shiftKey: true });
    expect(currentSelection()).toEqual(['c2']);
    expect(screen.getByTestId('row-c2')).toHaveAttribute('data-selected');
    expect(screen.queryByTestId('pending-pane')).toBeNull();
    expect(screen.getByTestId('row-c1')).toHaveAttribute('aria-current', 'true');
    click(screen.getByTestId('row-c2'), { shiftKey: true });
    expect(currentSelection()).toEqual([]);
    act(() => clearSelected());
  });
});
