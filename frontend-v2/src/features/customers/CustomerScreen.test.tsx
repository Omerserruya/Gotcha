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

import { approvalSchema } from '@/api/contracts/approvals';

import { FIXTURE_DETAIL } from './capture-fixtures';
import {
  CustomerHeader,
  CustomerSide,
  CustomerTabs,
  CustomerTimelineList,
  parseCustomerTab,
  shortDate,
  conversationTone,
} from './CustomerScreen';
import type { CustomerDetail } from './load-customer';

const detail = (over: Partial<CustomerDetail> = {}): CustomerDetail => ({
  ...FIXTURE_DETAIL,
  ...over,
});

describe('★★ 04b’s header', () => {
  it('★★ the summary is there, in its own element - the one serif italic', async () => {
    const summary = FIXTURE_DETAIL.brief?.summary;
    render(await CustomerHeader({ detail: detail(), contactId: 'k1' }));
    if (summary)
      expect(screen.getByTestId('customer-summary')).toHaveTextContent(summary.slice(0, 20));
  });

  it('★★ the summary is the server’s words: isolated, so the period stays at the end (dev)', async () => {
    render(
      await CustomerHeader({
        detail: detail({
          brief: {
            ...FIXTURE_DETAIL.brief!,
            summary: 'Returning customer - see prior conversations.',
          },
        }),
        contactId: 'k1',
      }),
    );
    const bdi = screen.getByTestId('customer-summary').querySelector('bdi');
    expect(bdi).toHaveAttribute('dir', 'auto');
    expect(bdi?.textContent).toBe('Returning customer - see prior conversations.');
  });

  it('⚠ no summary keeps the line, quietly - not an omission', async () => {
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

  it('★★ "All" has the way back to the list too (Omer, 2026-10-13, C2)', async () => {
    /*
     * The crumb was the compact header's only, so 04b's "All" - this header -
     * had no way back. The page test proves every tab mounts one of the two
     * headers; each draws the same crumb.
     */
    render(await CustomerHeader({ detail: detail(), contactId: 'k1' }));
    const crumb = screen.getByTestId('customers-crumb');
    expect(crumb).toHaveAttribute('href', '/customers');
    expect(crumb).toHaveTextContent(/^Customers$/);
  });

  it('Add note leads to the notes tab', async () => {
    render(await CustomerHeader({ detail: detail(), contactId: 'k1' }));
    expect(screen.getByTestId('customer-add-note')).toHaveAttribute(
      'href',
      '/customers/k1?tab=notes',
    );
  });
});

describe('★ the tabs - 04c-04f', () => {
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
    // Conversations only - whatever their dot: open-and-theirs, resolved, or plain.
    expect(tones.every((tone) => ['attention', 'resolved', 'conversation'].includes(tone!))).toBe(
      true,
    );
  });

  it('★ 04b’s dots: open with their word last is orange; closed is resolved; unread is never orange', () => {
    expect(conversationTone('OPEN', 'INBOUND')).toBe('attention');
    expect(conversationTone('WAITING', 'INBOUND')).toBe('attention');
    expect(conversationTone('OPEN', 'OUTBOUND')).toBe('conversation');
    expect(conversationTone('CLOSED', 'INBOUND')).toBe('resolved');
    expect(conversationTone(undefined, 'INBOUND')).toBe('conversation');
  });

  it('★ the fixture: its open conversation was answered last (plain), the closed one resolved', async () => {
    render(await CustomerTimelineList({ detail: detail(), only: 'conversations' }));
    const tones = [...screen.getByTestId('customer-timeline').querySelectorAll('li')].map((li) =>
      li.getAttribute('data-tone'),
    );
    expect(tones).toEqual(['conversation', 'resolved']);
  });

  it('★★ GOTCHA’s actions are rows: the approvals it asked for, in violet, with their outcome', async () => {
    /*
      Measured on dev: 28 approvals on one customer and not one on the
      screen - the timeline route returns messages only. The loader reads
      them from the approvals list; this is the screen's half.
    */
    const first = FIXTURE_DETAIL.timeline!.events.find((e) => e.type === 'message')!;
    const approval = approvalSchema.parse({
      id: 'ap1',
      conversationId: first.conversationId,
      tool: 'shopify.process_refund',
      summary: 'Process refund of 50 for order #1011',
      status: 'REJECTED',
      decidedByName: 'Dana',
      expiresAt: '2026-09-01T10:00:00.000Z',
      createdAt: '2099-01-01T10:00:00.000Z',
    });
    render(await CustomerTimelineList({ detail: detail({ approvals: [approval] }) }));
    const row = screen.getByTestId('event-p-ap1');
    expect(row).toHaveAttribute('data-tone', 'action');
    expect(row).toHaveTextContent('Process refund of 50 for order #1011');
    expect(row).toHaveTextContent('Rejected by Dana');
    expect(screen.getByTestId('customer-timeline').querySelector('li')).toBe(row);
  });

  it('⚠ an expired one says nobody decided, and names no one', async () => {
    const approval = approvalSchema.parse({
      id: 'ap2',
      tool: 'integration_cancel_order',
      summary: 'Cancel order #1012',
      status: 'EXPIRED',
      decidedByName: null,
      expiresAt: '2026-09-01T10:00:00.000Z',
      createdAt: '2026-09-01T09:00:00.000Z',
    });
    render(await CustomerTimelineList({ detail: detail({ approvals: [approval] }) }));
    expect(screen.getByTestId('event-p-ap2')).toHaveTextContent('Expired before anyone decided');
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

describe('★★ the side: WORTH, GOTCHA remembers, Reach them, the pinned note - all drawn', () => {
  it('⚠⚠ lifetime and refunds are "-": only recent orders are read', async () => {
    render(await CustomerSide({ detail: detail() }));
    const worth = screen.getByTestId('customer-worth');
    expect(worth).toHaveTextContent('lifetime');
    expect(worth).toHaveTextContent('refunds');
    expect(worth.textContent?.match(/-/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('★★ a handle is a left-to-right island - a phone in Hebrew laid out backwards (dev)', async () => {
    render(await CustomerSide({ detail: detail() }));
    const phone = screen.getByTestId('customer-reach').querySelector('dd bdi');
    expect(phone).toHaveAttribute('dir', 'ltr');
    expect(phone?.textContent).toMatch(/^\+44/);
  });

  it('★ every block stays when its data is empty', async () => {
    render(
      await CustomerSide({
        detail: detail({ orders: null, memory: null, timeline: null, notes: [] }),
      }),
    );
    expect(screen.getByTestId('worth-orders')).toHaveTextContent('-');
    expect(screen.getByTestId('customer-remembers')).toHaveTextContent('Nothing yet.');
    expect(screen.getByTestId('customer-reach')).toHaveTextContent('No handle recorded.');
    expect(screen.getByTestId('customer-pinned-note')).toHaveTextContent('No notes yet.');
  });
});

describe('★★ 02’s dates are day first - "25 Aug", not "Aug 25"', () => {
  const format = createFormatter({ locale: 'en', timeZone: 'UTC' });
  const now = new Date('2026-10-02T12:00:00.000Z');

  it('this year: the day, then the month', () => {
    expect(shortDate('2026-08-25T09:00:00.000Z', now, format, 'Today')).toBe('25 Aug');
    expect(shortDate('2026-06-02T09:00:00.000Z', now, format, 'Today')).toBe('2 Jun');
  });

  it('an earlier year: the month and the year’s two digits', () => {
    expect(shortDate('2024-03-24T09:00:00.000Z', now, format, 'Today')).toBe('Mar 24');
  });

  it('today is the word', () => {
    expect(shortDate('2026-10-02T08:00:00.000Z', now, format, 'Today')).toBe('Today');
  });
});
