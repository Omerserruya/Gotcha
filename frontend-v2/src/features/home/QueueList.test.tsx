import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { queueItemSchema } from '@/api/contracts/analytics';
import channels from '@/i18n/messages/en/channels.json';
import home from '@/i18n/messages/en/home.json';
import inbox from '@/i18n/messages/en/inbox.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { home, channels, inbox },
      namespace: namespace as 'home',
    }),
}));
vi.mock('@/i18n/navigation', () => ({
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

import { QueueList } from './QueueList';

describe('★ Home’s queue opens the conversation it names', () => {
  it('each row links to /inbox?c=<id> - the parameter the inbox reads (it was ?conversation=, which opened nothing)', async () => {
    const item = queueItemSchema.parse({
      conversationId: 'conv 7',
      customer: { id: '+972541234567', name: 'Dana' },
      channel: 'WHATSAPP',
      preview: 'Hi',
      intent: 'OTHER',
      waitingSince: '2026-10-08T09:00:00Z',
      rank: 1,
    });
    render(
      await QueueList({ items: [item], totalWaiting: 1, now: new Date('2026-10-08T10:00:00Z') }),
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/inbox?c=conv+7');
  });
});

describe('★★ "N more" is the rest of the QUEUE - named, since a bare /inbox is "Assigned to me"', () => {
  it('links to /inbox?view=queue (Omer, 2026-10-11)', async () => {
    const item = queueItemSchema.parse({
      conversationId: 'c1',
      customer: { id: '+972541234567', name: 'Dana' },
      channel: 'WHATSAPP',
      preview: 'Hi',
      intent: 'OTHER',
      waitingSince: '2026-10-08T09:00:00Z',
      rank: 1,
    });
    render(
      await QueueList({ items: [item], totalWaiting: 6, now: new Date('2026-10-08T10:00:00Z') }),
    );
    const more = screen
      .getAllByRole('link')
      .find((link) => !link.getAttribute('href')?.includes('c='));
    expect(more).toHaveAttribute('href', '/inbox?view=queue');
  });
});

describe('★★ one person: the card lists open conversations (2026-11-15)', () => {
  const open = (over: Record<string, unknown> = {}) => ({
    conversationId: 'c1',
    customer: { id: '+972541234567', name: 'Dana' },
    channel: 'WHATSAPP',
    preview: 'Hi',
    intent: null,
    waitingSince: '2026-11-15T09:00:00Z',
    ...over,
  });
  const now = new Date('2026-11-15T10:00:00Z');

  it('★★ "N more open" opens the inbox\'s "Open"', async () => {
    render(await QueueList({ items: [open()], totalWaiting: 3, now, of: 'open' }));
    const more = screen.getByText(/more open/);
    expect(more).toHaveTextContent('2 more open · open Inbox');
    expect(more.closest('a')).toHaveAttribute('href', '/inbox?view=open');
  });

  it('★ nobody ranked it: no intent chip - never a guessed "Other"', async () => {
    render(await QueueList({ items: [open()], totalWaiting: 1, now, of: 'open' }));
    expect(screen.queryByText(home.needsYou.intent.OTHER)).toBeNull();
    expect(screen.getByText('1h')).toBeInTheDocument();
  });

  it('★★ no name: the number, as the inbox list says it (prod 2026-11-17)', async () => {
    render(
      await QueueList({
        items: [open({ customer: { id: '+972541234567', name: null } })],
        totalWaiting: 1,
        now,
        of: 'open',
      }),
    );
    expect(screen.getByTestId('customer-handle')).toHaveTextContent('054-123-4567');
    expect(screen.queryByText('+972541234567')).toBeNull();
  });

  it('★ no time is no age; no name and no handle is the inbox\'s "Someone"', async () => {
    render(
      await QueueList({
        items: [open({ customer: { id: '', name: null }, waitingSince: null })],
        totalWaiting: 1,
        now,
        of: 'open',
      }),
    );
    expect(screen.getByText(inbox.queue.unnamed)).toBeInTheDocument();
    expect(screen.queryByText(/\d+[mhd]$/)).toBeNull();
  });
});
