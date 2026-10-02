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
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query ?? {})}`} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('server-only', () => ({}));

import { FIXTURE_DETAIL } from './capture-fixtures';
import {
  CustomerHeader,
  CustomerSide,
  CustomerTabs,
  CustomerTimelineList,
  parseCustomerTab,
} from './CustomerScreen';
import type { CustomerDetail } from './load-customer';

const detail = (over: Partial<CustomerDetail> = {}): CustomerDetail => ({
  ...FIXTURE_DETAIL,
  ...over,
});

describe('★★ 04b’s header', () => {
  it('★★ the summary is there, in its own element — the one serif italic', async () => {
    const summary = FIXTURE_DETAIL.brief?.summary;
    render(await CustomerHeader({ detail: detail(), contactId: 'k1' }));
    if (summary)
      expect(screen.getByTestId('customer-summary')).toHaveTextContent(summary.slice(0, 20));
  });

  it('⚠ no summary keeps the line, quietly — not an omission', async () => {
    render(await CustomerHeader({ detail: detail({ brief: null }), contactId: 'k1' }));
    const line = screen.getByTestId('customer-summary');
    expect(line).toHaveAttribute('data-empty');
    expect(line).toHaveTextContent(/No summary yet/);
  });

  it('★ Message opens their newest conversation; with none, it is present and disabled', async () => {
    const { unmount } = render(
      await CustomerHeader({ detail: detail({ conversationId: 'c9' }), contactId: 'k1' }),
    );
    expect(screen.getByTestId('customer-message')).toHaveAttribute('href', '/inbox?c=c9');
    unmount();
    render(await CustomerHeader({ detail: detail({ conversationId: null }), contactId: 'k1' }));
    expect(screen.getByTestId('customer-message')).toHaveAttribute('aria-disabled', 'true');
  });

  it('Add note leads to the notes tab', async () => {
    render(await CustomerHeader({ detail: detail(), contactId: 'k1' }));
    expect(screen.getByTestId('customer-add-note')).toHaveAttribute(
      'href',
      '/customers/k1?tab=notes',
    );
  });
});

describe('★ the tabs — 04c–04f', () => {
  it('marks the open one, and an unknown tab is Everything', async () => {
    expect(parseCustomerTab('orders')).toBe('orders');
    expect(parseCustomerTab('nope')).toBe('everything');
    render(await CustomerTabs({ contactId: 'k1', tab: 'orders' }));
    expect(screen.getByTestId('tab-orders')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('tab-everything')).not.toHaveAttribute('aria-current');
  });
});

describe('★★ the timeline: one stream, conversations, orders, actions and notes', () => {
  it('★ draws something for every kind the record holds', async () => {
    render(await CustomerTimelineList({ detail: detail() }));
    const tones = new Set(
      [...screen.getByTestId('customer-timeline').querySelectorAll('li')].map((li) =>
        li.getAttribute('data-tone'),
      ),
    );
    expect(tones.has('conversation')).toBe(true);
  });

  it('⚠ the conversations tab is conversations only', async () => {
    render(await CustomerTimelineList({ detail: detail(), only: 'conversations' }));
    const tones = [...screen.getByTestId('customer-timeline').querySelectorAll('li')].map((li) =>
      li.getAttribute('data-tone'),
    );
    expect(new Set(tones)).toEqual(new Set(['conversation']));
  });

  it('an empty record says so in one line', async () => {
    render(
      await CustomerTimelineList({
        detail: detail({ timeline: null, orders: null, notes: [] }),
      }),
    );
    expect(screen.getByTestId('timeline-empty')).toBeInTheDocument();
  });
});

describe('★★ the side: WORTH, GOTCHA remembers, Reach them, the pinned note — all drawn', () => {
  it('⚠⚠ lifetime and refunds are "—": only recent orders are read', async () => {
    render(await CustomerSide({ detail: detail() }));
    const worth = screen.getByTestId('customer-worth');
    expect(worth).toHaveTextContent('lifetime');
    expect(worth).toHaveTextContent('refunds');
    expect(worth.textContent?.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('★ every block stays when its data is empty', async () => {
    render(
      await CustomerSide({
        detail: detail({ orders: null, memory: null, timeline: null, notes: [] }),
      }),
    );
    expect(screen.getByTestId('worth-orders')).toHaveTextContent('—');
    expect(screen.getByTestId('customer-remembers')).toHaveTextContent('Nothing yet.');
    expect(screen.getByTestId('customer-reach')).toHaveTextContent('No handle recorded.');
    expect(screen.getByTestId('customer-pinned-note')).toHaveTextContent('No notes yet.');
  });
});
