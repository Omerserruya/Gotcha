import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { THREADS_CHANGED } from '@/api/contracts/assistant-threads';
import home from '@/i18n/messages/en/home.json';
import navigation from '@/i18n/messages/en/navigation.json';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/api/client/browser-api', () => ({ browserApi: api }));
const nav = vi.hoisted(() => ({ path: '/home', params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params }));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => nav.path,
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
}));

import { RECENT_LIMIT, RecentThreads } from './RecentThreads';

const answering =
  (value: unknown) =>
  async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(value);

const show = async () => {
  render(
    <NextIntlClientProvider locale="en" messages={{ navigation, home }}>
      <RecentThreads />
    </NextIntlClientProvider>,
  );
  await act(async () => {});
};

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  api.delete.mockReset();
  nav.path = '/home';
  nav.params = new URLSearchParams();
});

describe('★ Recent (01a): the person’s own threads, one click back to each', () => {
  it('the latest few, newest first as the route sends them, each to its thread on Home', async () => {
    api.get.mockImplementation(
      answering({
        data: [
          { id: 't2', title: 'Returns up this week', updatedAt: 'x' },
          { id: 't1', title: null, updatedAt: 'x' },
        ],
        nextCursor: null,
      }),
    );
    await show();
    expect(api.get.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads' },
      query: { limit: RECENT_LIMIT },
      raw: true,
    });
    expect(screen.getByTestId('recent-threads')).toHaveTextContent(/^Recent/);
    expect(screen.getByTestId('recent-t2')).toHaveAttribute('href', '/home?thread=t2');
    expect(screen.getByTestId('recent-t2')).toHaveTextContent('Returns up this week');
    // Not titled yet: said as new, never blank.
    expect(screen.getByTestId('recent-t1')).toHaveTextContent('New conversation');
  });

  it('the one open on Home is marked; the others are not', async () => {
    api.get.mockImplementation(
      answering({
        data: [
          { id: 't2', title: 'A' },
          { id: 't1', title: 'B' },
        ],
        nextCursor: null,
      }),
    );
    nav.params = new URLSearchParams('thread=t1');
    await show();
    expect(screen.getByTestId('recent-t1')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('recent-t2')).not.toHaveAttribute('aria-current');
  });

  it('★ Home’s only (Omer, 2026-10-08): elsewhere the rail neither draws it nor reads it', async () => {
    api.get.mockImplementation(answering({ data: [{ id: 't1', title: 'B' }], nextCursor: null }));
    for (const path of ['/inbox', '/customers', '/settings/workspace', '/homework']) {
      nav.path = path;
      nav.params = new URLSearchParams('thread=t1');
      const { unmount } = render(
        <NextIntlClientProvider locale="en" messages={{ navigation, home }}>
          <RecentThreads />
        </NextIntlClientProvider>,
      );
      await act(async () => {});
      expect(screen.queryByTestId('recent-threads')).toBeNull();
      unmount();
    }
    expect(api.get).not.toHaveBeenCalled();
    nav.path = '/home';
    await show();
    expect(screen.getByTestId('recent-t1')).toBeInTheDocument();
  });

  it('★ reads again when a thread is made, titled, renamed or deleted', async () => {
    api.get.mockImplementationOnce(answering({ data: [], nextCursor: null }));
    await show();
    expect(screen.queryByTestId('recent-threads')).toBeNull();
    api.get.mockImplementationOnce(
      answering({ data: [{ id: 't9', title: 'Open conversations' }], nextCursor: null }),
    );
    await act(async () => {
      window.dispatchEvent(new CustomEvent(THREADS_CHANGED));
    });
    expect(screen.getByTestId('recent-t9')).toHaveTextContent('Open conversations');
  });

  it('a list that could not be read draws nothing - never a list of nothing', async () => {
    api.get.mockRejectedValue(new Error('down'));
    await show();
    expect(screen.queryByTestId('recent-threads')).toBeNull();
  });
});

describe('★★ each thread has a menu: Rename, Delete', () => {
  const two = () =>
    api.get.mockImplementation(
      answering({
        data: [
          { id: 't2', title: 'Returns up this week' },
          { id: 't1', title: 'Open conversations' },
        ],
        nextCursor: null,
      }),
    );
  const heard: unknown[] = [];
  const listen = (event: Event) => heard.push((event as CustomEvent).detail ?? null);
  beforeEach(() => {
    heard.length = 0;
    window.addEventListener(THREADS_CHANGED, listen);
    return () => window.removeEventListener(THREADS_CHANGED, listen);
  });

  it('a right-click on the row opens it - the same two items', async () => {
    two();
    await show();
    fireEvent.contextMenu(screen.getByTestId('recent-t2'), { clientX: 10, clientY: 10 });
    const menu = await screen.findByTestId('recent-context-t2');
    expect(menu).toHaveTextContent('Rename');
    expect(menu).toHaveTextContent('Delete');
    expect(screen.queryByTestId('recent-context-t1')).toBeNull();
  });

  it('⋯ opens it, named for its thread', async () => {
    two();
    await show();
    const more = screen.getByTestId('recent-more-t2');
    expect(more).toHaveAccessibleName('More for Returns up this week');
    fireEvent.keyDown(more, { key: 'Enter' });
    const menu = await screen.findByTestId('recent-menu-t2');
    expect(menu).toHaveTextContent('Rename');
    expect(menu).toHaveTextContent('Delete');
  });

  it('Delete asks Home’s question; yes deletes it, and it leaves the list', async () => {
    two();
    api.delete.mockResolvedValue(undefined);
    await show();
    fireEvent.keyDown(screen.getByTestId('recent-more-t1'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('recent-delete-t1'));
    expect(screen.getByTestId('recent-delete-dialog')).toHaveTextContent(
      'Delete this conversation?',
    );
    expect(api.delete).not.toHaveBeenCalled();
    api.get.mockImplementation(
      answering({ data: [{ id: 't2', title: 'Returns up this week' }], nextCursor: null }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-delete-yes'));
    });
    expect(api.delete.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/t1' },
    });
    expect(screen.queryByTestId('recent-t1')).toBeNull();
    expect(screen.getByTestId('recent-t2')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-delete-dialog')).toBeNull();
    // Home hears which one: the open one is the live Home again.
    expect(heard).toContainEqual({ id: 't1', deleted: true });
  });

  it('a delete that failed says so, and the thread stays', async () => {
    two();
    api.delete.mockRejectedValue(new Error('down'));
    await show();
    fireEvent.contextMenu(screen.getByTestId('recent-t1'), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByTestId('recent-context-delete-t1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('recent-delete-yes'));
    });
    expect(screen.getByTestId('recent-delete-failed')).toHaveTextContent("It wasn't deleted");
    expect(screen.getByTestId('recent-t1')).toBeInTheDocument();
    expect(heard).toEqual([]);
  });

  it('Rename is the inline edit: Enter saves the title, Escape keeps the old one', async () => {
    two();
    api.patch.mockImplementation(
      answering({ id: 't2', title: 'Refunds', createdAt: 'x', updatedAt: 'x' }),
    );
    await show();
    fireEvent.contextMenu(screen.getByTestId('recent-t2'), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByTestId('recent-context-rename-t2'));
    const input = screen.getByTestId('recent-title-input-t2');
    expect(input).toHaveValue('Returns up this week');
    fireEvent.change(input, { target: { value: '  Refunds ' } });
    // What the route answers afterwards: the new title (the event reads the list again).
    api.get.mockImplementation(
      answering({
        data: [
          { id: 't2', title: 'Refunds' },
          { id: 't1', title: 'Open conversations' },
        ],
        nextCursor: null,
      }),
    );
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(api.patch.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/assistant/threads/t2' },
      body: { title: 'Refunds' },
    });
    expect(screen.getByTestId('recent-t2')).toHaveTextContent('Refunds');
    expect(heard).toContainEqual({ id: 't2', title: 'Refunds' });

    fireEvent.keyDown(screen.getByTestId('recent-more-t1'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('recent-rename-t1'));
    fireEvent.change(screen.getByTestId('recent-title-input-t1'), { target: { value: 'X' } });
    fireEvent.keyDown(screen.getByTestId('recent-title-input-t1'), { key: 'Escape' });
    expect(screen.getByTestId('recent-t1')).toHaveTextContent('Open conversations');
    expect(api.patch).toHaveBeenCalledTimes(1);
  });
});
