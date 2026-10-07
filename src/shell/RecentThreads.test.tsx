import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { THREADS_CHANGED } from '@/api/contracts/assistant-threads';
import navigation from '@/i18n/messages/en/navigation.json';

const api = vi.hoisted(() => ({ get: vi.fn() }));
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
    <NextIntlClientProvider locale="en" messages={{ navigation }}>
      <RecentThreads />
    </NextIntlClientProvider>,
  );
  await act(async () => {});
};

beforeEach(() => {
  api.get.mockReset();
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

  it('off Home, `?thread=` means nothing to the rail: none is marked', async () => {
    api.get.mockImplementation(answering({ data: [{ id: 't1', title: 'B' }], nextCursor: null }));
    nav.path = '/inbox';
    nav.params = new URLSearchParams('thread=t1');
    await show();
    expect(screen.getByTestId('recent-t1')).not.toHaveAttribute('aria-current');
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
