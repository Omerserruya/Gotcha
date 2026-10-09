import { render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notificationSchema } from '@/api/contracts/notifications';
import notifications from '@/i18n/messages/en/notifications.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'notifications') =>
    createTranslator({ locale: 'en', messages: { notifications }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a
      href={typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`}
      {...rest}
    >
      {children}
    </a>
  ),
}));
// No test may write.
vi.mock('./mark-read', () => ({
  markRead: () => {
    throw new Error('write');
  },
  markAllRead: () => {
    throw new Error('write');
  },
}));
const loadNotifications = vi.hoisted(() => vi.fn());
vi.mock('./load-notifications', () => ({ loadNotifications }));

import { NotificationsPanel } from './NotificationsPanel';

const NOW = new Date('2026-10-03T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const item = (over: Record<string, unknown>) => notificationSchema.parse(over);

const ITEMS = [
  item({
    id: 'a',
    eventType: 'tool.action_failed',
    priority: 'CRITICAL',
    title: 'Returns platform stopped',
    body: '11 held',
    link: '/settings/systems',
    createdAt: minutesAgo(2),
  }),
  item({
    id: 'b',
    eventType: 'tool.approval_required',
    priority: 'HIGH',
    title: 'Refund needs approval',
    createdAt: minutesAgo(90),
    read: true,
    link: 'https://evil.example',
  }),
  item({
    id: 'c',
    eventType: 'broadcast.completed',
    priority: 'LOW',
    title: 'Campaign finished',
    read: true,
    link: '/outreach',
    createdAt: minutesAgo(60 * 30),
  }),
];

const panel = async (
  data: { items: unknown[]; unread: number; failed: boolean },
  kind: 'decision' | 'broken' | null = null,
) => {
  loadNotifications.mockResolvedValue({ nextCursor: null, ...data });
  return render(await NotificationsPanel({ kind, now: NOW }));
};

beforeEach(() => {
  loadNotifications.mockReset();
});

describe('★★ 01d - a panel of decisions and failures', () => {
  it('the head: "N new", Mark all read, Settings', async () => {
    await panel({ items: ITEMS, unread: 2, failed: false });
    expect(screen.getByTestId('notifications-new')).toHaveTextContent('2 new');
    expect(screen.getByTestId('notifications-mark-all')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toHaveAttribute('href', '/settings/notifications');
  });

  it('★ a body is drawn only when it says something - "" (391c0a09) and spaces are no line at all', async () => {
    await panel({
      items: [
        item({ id: 'e', title: 'Campaign finished', body: '', createdAt: minutesAgo(1) }),
        item({ id: 's', title: 'Refund needs approval', body: '   ', createdAt: minutesAgo(1) }),
        ...ITEMS,
      ],
      unread: 2,
      failed: false,
    });
    expect(screen.queryByTestId('notification-body-e')).toBeNull();
    expect(screen.queryByTestId('notification-body-s')).toBeNull();
    expect(screen.getByTestId('notification-body-a')).toHaveTextContent('11 held');
  });

  it('nothing unread: no "0 new", no Mark all read', async () => {
    await panel({ items: ITEMS, unread: 0, failed: false });
    expect(screen.queryByTestId('notifications-new')).toBeNull();
    expect(screen.queryByTestId('notifications-mark-all')).toBeNull();
  });

  it('filters count from the catalogue’s keys, and link to themselves', async () => {
    await panel({ items: ITEMS, unread: 2, failed: false });
    expect(screen.getByTestId('notifications-filter-all')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('notifications-filter-decision')).toHaveTextContent(
      'Needs a decision · 1',
    );
    expect(screen.getByTestId('notifications-filter-broken')).toHaveAttribute(
      'href',
      '/home?notifications=1&kind=broken',
    );
  });

  it('grouped: Now, Earlier today, Earlier', async () => {
    await panel({ items: ITEMS, unread: 2, failed: false });
    expect(
      within(screen.getByTestId('notifications-group-now')).getByText('Returns platform stopped'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('notifications-group-today')).getByText('Refund needs approval'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('notifications-group-earlier')).getByText('Campaign finished'),
    ).toBeInTheDocument();
  });

  it('a row: its one action where the link is ours, Mark read only while unread', async () => {
    await panel({ items: ITEMS, unread: 2, failed: false });
    expect(screen.getByTestId('notification-open-a')).toHaveAttribute('href', '/settings/systems');
    expect(screen.getByTestId('notification-read-a')).toBeInTheDocument();
    // An outside link is never an href; read already, so no Mark read either.
    expect(screen.queryByTestId('notification-open-b')).toBeNull();
    expect(screen.queryByTestId('notification-read-b')).toBeNull();
    expect(screen.getByText('2m')).toBeInTheDocument();
    // Read, with a link of ours: Open it, and no Mark read.
    expect(screen.getByTestId('notification-open-c')).toHaveAttribute('href', '/outreach');
    expect(screen.queryByTestId('notification-read-c')).toBeNull();
  });

  it('a filter shows only its kind', async () => {
    await panel({ items: ITEMS, unread: 2, failed: false }, 'broken');
    expect(screen.getByText('Returns platform stopped')).toBeInTheDocument();
    expect(screen.queryByText('Refund needs approval')).toBeNull();
    expect(screen.queryByText('Campaign finished')).toBeNull();
  });

  it('empty is a state inside the panel; a failed read is not empty', async () => {
    await panel({ items: [], unread: 0, failed: false });
    expect(screen.getByTestId('notifications-empty')).toHaveTextContent('Nothing to tell you');
    loadNotifications.mockReset();
    document.body.innerHTML = '';
    await panel({ items: [], unread: 0, failed: true });
    expect(screen.getByTestId('notifications-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('notifications-empty')).toBeNull();
  });

  it('★ the foot says what the catalogue makes true', async () => {
    await panel({ items: [], unread: 0, failed: false });
    expect(screen.getByText(/never told about an incoming message/)).toBeInTheDocument();
  });
});
