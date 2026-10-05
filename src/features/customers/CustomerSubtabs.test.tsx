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
  MAX_MORE,
  parseMore,
  PromiseCard,
  timelineLimit,
} from './CustomerSubtabs';
import type { CustomerDetail } from './load-customer';

const message = (over: Partial<TimelineEvent>): TimelineEvent =>
  ({
    ...FIXTURE_DETAIL.timeline!.events.find((e) => e.type === 'message')!,
    ...over,
  }) as TimelineEvent;

/** A whole history of these events: totals agree with them, nothing more to page. */
const withEvents = (events: TimelineEvent[]): CustomerDetail => ({
  ...FIXTURE_DETAIL,
  timeline: {
    ...FIXTURE_DETAIL.timeline!,
    events,
    totals: {
      ...FIXTURE_DETAIL.timeline!.totals,
      conversations: new Set(events.map((e) => e.conversationId)).size,
    },
    page: { ...FIXTURE_DETAIL.timeline!.page, hasMore: false },
  },
});

describe('★★ 04c–04f’s compact header', () => {
  it('the crumb back to Customers, the name, and both actions', async () => {
    render(await CustomerTopBar({ detail: FIXTURE_DETAIL, contactId: 'k1' }));
    // The page's one h1 is the person, as on 04b.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    const bar = screen.getByTestId('customer-top-bar');
    expect(bar.querySelector('a[href="/customers"]')).toHaveTextContent('Customers');
    expect(screen.getByTestId('customer-add-note')).toHaveAttribute(
      'href',
      '/customers/k1?tab=notes',
    );
    expect(screen.getByTestId('customer-message')).toBeInTheDocument();
  });

  it('★★ the same facts line as 04b — never a lone "—" under the name', async () => {
    const reaching: CustomerDetail = {
      ...FIXTURE_DETAIL,
      timeline: {
        ...FIXTURE_DETAIL.timeline!,
        page: { ...FIXTURE_DETAIL.timeline!.page, hasMore: true },
        identityChannels: [
          { ...FIXTURE_DETAIL.timeline!.identityChannels[0]!, channel: 'WHATSAPP' },
        ],
      },
    };
    render(await CustomerTopBar({ detail: reaching, contactId: 'k1' }));
    expect(screen.getByTestId('customer-top-facts')).toHaveTextContent('reaches you on WhatsApp');
    expect(screen.getByTestId('customer-top-bar').textContent).not.toMatch(/(^|\s)—(\s|$)/);
  });

  it('⚠ with no facts at all, no line — rather than a dash that looks broken', async () => {
    const bare: CustomerDetail = {
      ...FIXTURE_DETAIL,
      timeline: {
        ...FIXTURE_DETAIL.timeline!,
        page: { ...FIXTURE_DETAIL.timeline!.page, hasMore: true },
        identityChannels: [],
        contact: { ...FIXTURE_DETAIL.timeline!.contact!, createdAt: null },
      },
    };
    render(await CustomerTopBar({ detail: bare, contactId: 'k1' }));
    expect(screen.queryByTestId('customer-top-facts')).toBeNull();
    expect(screen.getByTestId('customer-top-bar')).not.toHaveTextContent('—');
  });

  it('★ "with you since" is when the contact was made — whatever part of the history is here', async () => {
    const partial: CustomerDetail = {
      ...FIXTURE_DETAIL,
      timeline: {
        ...FIXTURE_DETAIL.timeline!,
        page: { ...FIXTURE_DETAIL.timeline!.page, hasMore: true },
      },
    };
    render(await CustomerTopBar({ detail: partial, contactId: 'k1' }));
    expect(screen.getByTestId('customer-top-bar')).toHaveTextContent('with you since March 2024');
  });

  it('⚠ no created date and only part of the history: no "since" — the oldest word shown is not the first', async () => {
    const partial: CustomerDetail = {
      ...FIXTURE_DETAIL,
      timeline: {
        ...FIXTURE_DETAIL.timeline!,
        page: { ...FIXTURE_DETAIL.timeline!.page, hasMore: true },
        contact: { ...FIXTURE_DETAIL.timeline!.contact!, createdAt: null },
      },
    };
    render(await CustomerTopBar({ detail: partial, contactId: 'k1' }));
    expect(screen.getByTestId('customer-top-bar')).not.toHaveTextContent('with you since');
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
    render(await ConversationsTab({ detail, contactId: 'k1', channel: null, more: 0 }));
    const cards = [...screen.getByTestId('conversation-cards').querySelectorAll('li')];
    expect(cards.map((li) => li.dataset.testid)).toEqual(['conversation-new', 'conversation-old']);
    expect(cards[0]!.querySelector('article')).toHaveAttribute('data-newest');
    expect(cards[1]!.querySelector('article')).not.toHaveAttribute('data-newest');
  });

  it('★ the title is their first words, the line their latest, the pill the count', async () => {
    render(await ConversationsTab({ detail, contactId: 'k1', channel: null, more: 0 }));
    const card = screen.getByTestId('conversation-new');
    expect(card).toHaveTextContent('Where is my order');
    expect(card).toHaveTextContent('Thanks, and the invoice?');
    expect(card).toHaveTextContent('3 messages');
    expect(screen.getByTestId('open-new')).toHaveAttribute('href', '/inbox?c=new');
  });

  it('★ ?channel= keeps that channel’s conversations only', async () => {
    render(await ConversationsTab({ detail, contactId: 'k1', channel: 'EMAIL', more: 0 }));
    const cards = [...screen.getByTestId('conversation-cards').querySelectorAll('li')];
    expect(cards.map((li) => li.dataset.testid)).toEqual(['conversation-old']);
    expect(screen.getByText(/One conversation/)).toBeInTheDocument();
  });

  it('⚠ an imported conversation says so', async () => {
    render(
      await ConversationsTab({
        detail: withEvents([message({ conversationId: 'imp', origin: 'HISTORICAL_IMPORT' })]),
        contactId: 'k1',
        channel: null,
        more: 0,
      }),
    );
    expect(screen.getByTestId('conversation-imp')).toHaveTextContent('Imported');
  });

  it('⚠ no conversations: the heading stays, and one line says so', async () => {
    render(
      await ConversationsTab({ detail: withEvents([]), contactId: 'k1', channel: null, more: 0 }),
    );
    expect(screen.getByTestId('conversations-empty')).toBeInTheDocument();
    expect(screen.getByText(/0 conversations/)).toBeInTheDocument();
  });
});

describe('★★ the true total, and the older ones below — one number on one screen', () => {
  const page = (over: { conversations: number; hasMore: boolean }) =>
    ({
      ...FIXTURE_DETAIL,
      timeline: {
        ...FIXTURE_DETAIL.timeline!,
        events: [
          message({ id: 'x1', conversationId: 'c-a', createdAt: '2026-02-01T09:00:00.000Z' }),
          message({ id: 'x2', conversationId: 'c-b', createdAt: '2026-01-01T09:00:00.000Z' }),
        ],
        totals: { ...FIXTURE_DETAIL.timeline!.totals, conversations: over.conversations },
        page: { ...FIXTURE_DETAIL.timeline!.page, hasMore: over.hasMore },
      },
    }) satisfies CustomerDetail;

  it('★★ the heading says the person’s total, as the side does — not the page’s 20', async () => {
    render(
      await ConversationsTab({
        detail: page({ conversations: 70, hasMore: true }),
        contactId: 'k1',
        channel: null,
        more: 0,
      }),
    );
    expect(screen.getByText(/70 conversations/)).toBeInTheDocument();
    const older = screen.getByTestId('conversations-older');
    expect(older).toHaveTextContent('68 older conversations below');
    expect(older).toHaveAttribute('href', '/customers/k1?tab=conversations&more=1');
  });

  it('⚠ at the route’s cap the count stays, and there is nothing to press', async () => {
    render(
      await ConversationsTab({
        detail: page({ conversations: 70, hasMore: true }),
        contactId: 'k1',
        channel: null,
        more: MAX_MORE,
      }),
    );
    const older = screen.getByTestId('conversations-older');
    expect(older.tagName).toBe('P');
    expect(older).toHaveTextContent('68 older conversations below');
  });

  it('nothing older: no foot', async () => {
    render(
      await ConversationsTab({
        detail: page({ conversations: 2, hasMore: false }),
        contactId: 'k1',
        channel: null,
        more: 0,
      }),
    );
    expect(screen.queryByTestId('conversations-older')).toBeNull();
  });

  it('⚠ under a channel filter the per-channel total is unknown: more, without a number', async () => {
    render(
      await ConversationsTab({
        detail: page({ conversations: 70, hasMore: true }),
        contactId: 'k1',
        channel: 'WHATSAPP',
        more: 1,
      }),
    );
    const older = screen.getByTestId('conversations-older');
    expect(older).toHaveTextContent('Show older conversations');
    expect(older).toHaveAttribute(
      'href',
      '/customers/k1?tab=conversations&more=2&channel=WHATSAPP',
    );
  });

  it('parseMore and timelineLimit: 50 a step, never past 200', () => {
    expect(parseMore(undefined)).toBe(0);
    expect(parseMore('x')).toBe(0);
    expect(parseMore('-1')).toBe(0);
    expect(parseMore('2')).toBe(2);
    expect(parseMore('99')).toBe(MAX_MORE);
    expect(timelineLimit(0)).toBe(50);
    expect(timelineLimit(2)).toBe(150);
    expect(timelineLimit(MAX_MORE)).toBe(200);
    // The guard itself: should MAX_MORE ever grow, the route's cap still holds.
    expect(timelineLimit(9)).toBe(200);
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
