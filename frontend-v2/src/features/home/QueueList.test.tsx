import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { queueItemSchema } from '@/api/contracts/analytics';
import channels from '@/i18n/messages/en/channels.json';
import home from '@/i18n/messages/en/home.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { home, channels },
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
