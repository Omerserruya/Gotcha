import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import inbox from '@/i18n/messages/en/inbox.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox.clear') =>
    createTranslator({ locale: 'en', messages: { inbox }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
}));

import { ClearQueueList, ClearQueuePane } from './ClearQueue';

const overview = (over: Record<string, number> = {}) =>
  ({
    totalConversations: 86,
    aiHandledCount: 85,
    humanHandledCount: 1,
    avgResponseTimeMs: 19_000,
    aiHandledPct: 99,
    pendingApprovalCount: 0,
    ...over,
  }) as never;
const inFlight = (n: number) => ({
  conversationsHandling: n,
  toolsRunning: [],
  awaitingApproval: 0,
});

describe('★★ 02b - the list column: empty, but not blank', () => {
  it('✓, the title, today’s count, and what is still going on', async () => {
    render(await ClearQueueList({ clear: { overview: overview(), inFlight: inFlight(6) } }));
    expect(screen.getByText('The queue is clear')).toBeInTheDocument();
    expect(screen.getByTestId('queue-clear-line')).toHaveTextContent(
      'GOTCHA answered 85 conversations today. Anything it cannot handle will appear here.',
    );
    expect(screen.getByTestId('going-live')).toHaveTextContent('GOTCHA is on 6 conversations');
    expect(screen.getByTestId('going-live')).toHaveTextContent('live');
  });

  it('★ held and waiting are kinds of nothing nothing counts: "-", with why', async () => {
    render(await ClearQueueList({ clear: { overview: overview(), inFlight: inFlight(6) } }));
    expect(screen.getByTestId('going-held')).toHaveTextContent('-');
    expect(screen.getByTestId('going-held')).toHaveAttribute(
      'title',
      expect.stringMatching(/Nothing records/),
    );
    expect(screen.getByTestId('going-waiting')).toHaveTextContent('-');
  });

  it('no count of nothing: none handled, or no read, is the second sentence alone', async () => {
    render(
      await ClearQueueList({
        clear: { overview: overview({ aiHandledCount: 0 }), inFlight: null },
      }),
    );
    expect(screen.getByTestId('queue-clear-line')).toHaveTextContent(/^Anything it cannot handle/);
    expect(screen.getByTestId('going-live')).toHaveTextContent('-');
  });

  it('nothing in flight says so', async () => {
    render(await ClearQueueList({ clear: { overview: null, inFlight: inFlight(0) } }));
    expect(screen.getByTestId('going-live')).toHaveTextContent('not in a conversation right now');
  });
});

describe('★★ 02b - the pane: nothing to read, and the day', () => {
  it('"every conversation … without a person" only when that is true', async () => {
    render(
      await ClearQueuePane({
        clear: { overview: overview({ humanHandledCount: 0 }), inFlight: null },
      }),
    );
    expect(screen.getByTestId('nothing-line')).toHaveTextContent(
      'Every conversation today was answered without a person.',
    );
  });

  it('one passed to a person: a weaker sentence', async () => {
    render(await ClearQueuePane({ clear: { overview: overview(), inFlight: null } }));
    expect(screen.getByTestId('nothing-line')).toHaveTextContent('Nothing is waiting on you.');
  });

  it('the strip: today’s counts, the reply time, and "-" where nothing records why', async () => {
    render(await ClearQueuePane({ clear: { overview: overview(), inFlight: null } }));
    const strip = screen.getByTestId('clear-strip');
    expect(strip).toHaveTextContent('Answered today85');
    expect(strip).toHaveTextContent('Average reply time19s');
    expect(strip).toHaveTextContent('Passed to a person1');
    expect(screen.getByTitle(/Nothing records why/)).toHaveTextContent('-');
  });

  it('no conversations today: no counts of nothing', async () => {
    render(
      await ClearQueuePane({
        clear: {
          overview: overview({ totalConversations: 0, aiHandledCount: 0, humanHandledCount: 0 }),
          inFlight: null,
        },
      }),
    );
    expect(screen.getByTestId('clear-strip')).toHaveTextContent('Answered today-');
  });

  it('★ see what GOTCHA answered → the GOTCHA view - and no control that does nothing', async () => {
    const { container } = render(
      await ClearQueuePane({ clear: { overview: null, inFlight: null } }),
    );
    expect(screen.getByTestId('see-answered')).toHaveAttribute('href', '/inbox?view=gotcha');
    // "Write to a customer" was an aria-disabled role=button: dead, so not drawn (2026-10-12).
    expect(screen.queryByTestId('write-customer')).toBeNull();
    expect(container.querySelector('[aria-disabled="true"], [role="button"]')).toBeNull();
  });
});
