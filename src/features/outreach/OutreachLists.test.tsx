import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { campaignSchema, type Campaign } from '@/api/contracts/outreach';
import channels from '@/i18n/messages/en/channels.json';
import messages from '@/i18n/messages/en/outreach.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'outreach' | 'channels') =>
    createTranslator({ locale: 'en', messages: { outreach: messages, channels }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
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

import { InFlightList, MonthStrip } from './OutreachLists';

const campaign = (over: Record<string, unknown> = {}): Campaign =>
  campaignSchema.parse({
    id: 'c1',
    name: 'Linen restock',
    channel: 'WHATSAPP',
    status: 'SENDING',
    createdAt: '2026-10-01T09:00:00.000Z',
    startedAt: '2026-10-01T09:00:00.000Z',
    totalRecipients: 1240,
    sentCount: 794,
    failedCount: 0,
    readCount: 0,
    ...over,
  });

describe('★★ 05’s "In flight" - the parts the platform writes', () => {
  it('★ a row: the name, the channel and how many people', async () => {
    render(await InFlightList({ campaigns: [campaign()], selectedId: 'c1' }));
    const row = screen.getByTestId('row-c1');
    expect(row).toHaveTextContent('Linen restock');
    expect(row).toHaveTextContent('WhatsApp · 1,240 people');
    expect(row).toHaveAttribute('href', '/outreach?campaign=c1');
    expect(row).toHaveAttribute('aria-current', 'true');
  });

  it('⚠⚠ progress is SENT of recipients - never opened, read or replied, which nothing counts', async () => {
    render(await InFlightList({ campaigns: [campaign()], selectedId: null }));
    const progress = screen.getByTestId('progress-c1');
    // One line in 170px - 02's caption never wraps its row.
    expect(progress).toHaveTextContent('794 / 1,240 sent');
    expect(progress.textContent).not.toMatch(/open|read|repl|bought/i);
  });

  it('★ what did not arrive is said, when something did not', async () => {
    render(await InFlightList({ campaigns: [campaign({ failedCount: 12 })], selectedId: null }));
    expect(screen.getByTestId('progress-c1')).toHaveTextContent('794 / 1,240 sent · 12 failed');
  });

  it('★ a scheduled campaign shows when, not a bar at zero', async () => {
    render(
      await InFlightList({
        campaigns: [
          campaign({ status: 'SCHEDULED', scheduledAt: '2026-10-09T10:00:00.000Z', sentCount: 0 }),
        ],
        selectedId: null,
      }),
    );
    // 02: the date in the subline - 24-hour, no current year - and only
    // "Scheduled" in the middle column.
    const row = screen.getByTestId('row-c1');
    expect(row).toHaveTextContent(
      /WhatsApp · 1,240 people · (\w+day 10:00|9 Oct,? 10:00|Oct 9,? 10:00)/,
    );
    expect(row.textContent).not.toMatch(/2026|AM|PM/);
    expect(screen.queryByTestId('progress-c1')).toBeNull();
  });
});

describe('★ "This month" - reached, campaigns, didn’t arrive', () => {
  it('sums this month’s campaigns only', async () => {
    render(
      await MonthStrip({
        campaigns: [
          campaign({ id: 'a', sentCount: 100, failedCount: 2 }),
          campaign({ id: 'b', sentCount: 50, startedAt: '2026-10-02T09:00:00.000Z' }),
          campaign({ id: 'old', sentCount: 999, startedAt: '2026-09-20T09:00:00.000Z' }),
        ],
        now: new Date('2026-10-02T12:00:00.000Z'),
      }),
    );
    expect(screen.getByTestId('month-reached')).toHaveTextContent('150');
    expect(screen.getByTestId('month-campaigns')).toHaveTextContent('2');
    expect(screen.getByTestId('month-didntArrive')).toHaveTextContent('2');
  });

  it('⚠ and never a "replied" or "revenue" figure - neither is recorded', async () => {
    const { container } = render(
      await MonthStrip({ campaigns: [campaign()], now: new Date('2026-10-02') }),
    );
    expect(container.textContent).not.toMatch(/repl|revenue|opted/i);
  });
});
