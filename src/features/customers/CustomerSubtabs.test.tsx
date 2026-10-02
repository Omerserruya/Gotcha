import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';
import customers from '@/i18n/messages/en/customers.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'customers' | 'channels') =>
    createTranslator({ locale: 'en', messages: { customers, channels }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}?${new URLSearchParams(href.query ?? {})}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock('server-only', () => ({}));

import type { TimelineEvent } from '@/api/contracts/customer-detail';

import { FIXTURE_DETAIL } from './capture-fixtures';
import {
  ChannelFilters,
  channelsOf,
  ConversationsSide,
  ConversationsTab,
  CustomerTabRow,
  CustomerTopBar,
  PromiseCard,
} from './CustomerSubtabs';
import type { CustomerDetail } from './load-customer';

const message = (over: Partial<TimelineEvent>): TimelineEvent =>
  ({
    ...FIXTURE_DETAIL.timeline!.events.find((e) => e.type === 'message')!,
    ...over,
  }) as TimelineEvent;

const withEvents = (events: TimelineEvent[]): CustomerDetail => ({
  ...FIXTURE_DETAIL,
  timeline: { ...FIXTURE_DETAIL.timeline!, events },
});

describe('★★ 04c–04f’s compact header', () => {
  it('the crumb back to Customers, the name, and both actions', async () => {
    render(await CustomerTopBar({ detail: FIXTURE_DETAIL, contactId: 'k1' }));
    const bar = screen.getByTestId('customer-top-bar');
    expect(bar.querySelector('a[href="/customers"]')).toHaveTextContent('Customers');
    expect(screen.getByTestId('customer-add-note')).toHaveAttribute(
      'href',
      '/customers/k1?tab=notes',
    );
    expect(screen.getByTestId('customer-message')).toBeInTheDocument();
  });

  it('⚠ "with you since" only when the whole history is here; otherwise "—"', async () => {
    const partial: CustomerDetail = {
      ...FIXTURE_DETAIL,
      timeline: {
        ...FIXTURE_DETAIL.timeline!,
        page: { ...FIXTURE_DETAIL.timeline!.page, hasMore: true },
      },
    };
    render(await CustomerTopBar({ detail: partial, contactId: 'k1' }));
    expect(screen.getByTestId('customer-top-bar')).not.toHaveTextContent('with you since');
    expect(screen.getByTestId('customer-top-bar')).toHaveTextContent('—');
  });
});

describe('★ the tab row', () => {
  it('marks the open tab and holds that tab’s filters on the right', async () => {
    render(
      await CustomerTabRow({
        contactId: 'k1',
        tab: 'conversations',
        filters: <span data-testid="the-filters" />,
      }),
    );
    expect(screen.getByTestId('tab-conversations')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('tab-everything')).toHaveAttribute('href', '/customers/k1?');
    expect(screen.getByTestId('the-filters')).toBeInTheDocument();
  });

  it('★ the channel filters: All, then one square per channel they used, the current one marked', async () => {
    render(
      await ChannelFilters({
        contactId: 'k1',
        channels: ['WHATSAPP', 'EMAIL'],
        current: 'EMAIL',
      }),
    );
    expect(screen.getByTestId('filter-all')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('filter-EMAIL')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('filter-WHATSAPP')).toHaveAttribute(
      'href',
      '/customers/k1?tab=conversations&channel=WHATSAPP',
    );
  });

  it('channelsOf: each channel once, in the order first seen', () => {
    const detail = withEvents([
      message({ id: 'a', channel: 'WHATSAPP' }),
      message({ id: 'b', channel: 'EMAIL' }),
      message({ id: 'c', channel: 'WHATSAPP' }),
    ]);
    expect(channelsOf(detail)).toEqual(['WHATSAPP', 'EMAIL']);
  });
});

describe('★★ 04c — every conversation as a card on one spine', () => {
  const detail = withEvents([
    message({
      id: 'm1',
      conversationId: 'old',
      channel: 'EMAIL',
      direction: 'INBOUND',
      body: 'First question',
      createdAt: '2026-01-01T09:00:00.000Z',
    }),
    message({
      id: 'm2',
      conversationId: 'new',
      channel: 'WHATSAPP',
      direction: 'INBOUND',
      body: 'Where is my order',
      createdAt: '2026-02-01T09:00:00.000Z',
    }),
    message({
      id: 'm3',
      conversationId: 'new',
      channel: 'WHATSAPP',
      direction: 'OUTBOUND',
      body: 'On its way',
      createdAt: '2026-02-01T09:05:00.000Z',
    }),
    message({
      id: 'm4',
      conversationId: 'new',
      channel: 'WHATSAPP',
      direction: 'INBOUND',
      body: 'Thanks, and the invoice?',
      createdAt: '2026-02-01T09:10:00.000Z',
    }),
  ]);

  it('★★ one card per conversation, newest first, the newest marked', async () => {
    render(await ConversationsTab({ detail, channel: null }));
    const cards = [...screen.getByTestId('conversation-cards').querySelectorAll('li')];
    expect(cards.map((li) => li.dataset.testid)).toEqual(['conversation-new', 'conversation-old']);
    expect(cards[0]!.querySelector('article')).toHaveAttribute('data-newest');
    expect(cards[1]!.querySelector('article')).not.toHaveAttribute('data-newest');
  });

  it('★ the title is their first words, the line their latest, the pill the count', async () => {
    render(await ConversationsTab({ detail, channel: null }));
    const card = screen.getByTestId('conversation-new');
    expect(card).toHaveTextContent('Where is my order');
    expect(card).toHaveTextContent('Thanks, and the invoice?');
    expect(card).toHaveTextContent('3 messages');
    expect(screen.getByTestId('open-new')).toHaveAttribute('href', '/inbox?c=new');
  });

  it('★ ?channel= keeps that channel’s conversations only', async () => {
    render(await ConversationsTab({ detail, channel: 'EMAIL' }));
    const cards = [...screen.getByTestId('conversation-cards').querySelectorAll('li')];
    expect(cards.map((li) => li.dataset.testid)).toEqual(['conversation-old']);
    expect(screen.getByText(/One conversation/)).toBeInTheDocument();
  });

  it('⚠ an imported conversation says so', async () => {
    render(
      await ConversationsTab({
        detail: withEvents([message({ conversationId: 'imp', origin: 'HISTORICAL_IMPORT' })]),
        channel: null,
      }),
    );
    expect(screen.getByTestId('conversation-imp')).toHaveTextContent('Imported');
  });

  it('⚠ no conversations: the heading stays, and one line says so', async () => {
    render(await ConversationsTab({ detail: withEvents([]), channel: null }));
    expect(screen.getByTestId('conversations-empty')).toBeInTheDocument();
    expect(screen.getByText(/0 conversations/)).toBeInTheDocument();
  });
});

describe('★★ 04c’s side — every block drawn, data or not', () => {
  it('the three figures; "—" where there is none', async () => {
    render(
      await ConversationsSide({
        detail: { ...FIXTURE_DETAIL, timeline: null, brief: null },
      }),
    );
    const pattern = screen.getByTestId('customer-pattern');
    expect(pattern.textContent?.match(/—/g)).toHaveLength(3);
    expect(screen.getByTestId('customer-writes')).toHaveTextContent('Nothing yet.');
    expect(screen.getByTestId('customer-asks')).toHaveTextContent('Nothing yet.');
    expect(screen.getByTestId('promise-card')).toHaveTextContent('No open promises.');
  });

  it('★ the figures from the timeline’s totals', async () => {
    const detail: CustomerDetail = {
      ...FIXTURE_DETAIL,
      timeline: {
        ...FIXTURE_DETAIL.timeline!,
        totals: { ...FIXTURE_DETAIL.timeline!.totals, conversations: 24, handovers: 2 },
      },
    };
    render(await ConversationsSide({ detail }));
    const pattern = screen.getByTestId('customer-pattern');
    expect(pattern).toHaveTextContent('conversations24');
    expect(pattern).toHaveTextContent('needed a person2');
  });

  it('the promise card is drawn on its own too', async () => {
    render(<PromiseCard heading="An open promise" none="No open promises." />);
    expect(screen.getByTestId('promise-card')).toHaveTextContent('An open promise');
  });
});
