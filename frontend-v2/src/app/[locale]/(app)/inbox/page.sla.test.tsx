import { render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { conversationRowSchema } from '@/api/contracts/inbox';
import { ConversationList } from '@/features/inbox/ConversationList';
import channels from '@/i18n/messages/en/channels.json';
import common from '@/i18n/messages/en/common.json';
import inbox from '@/i18n/messages/en/inbox.json';
import navigation from '@/i18n/messages/en/navigation.json';

import type PageType from './page';

/**
 * ★★ W2 ON DEV, 2026-10-12, END TO END: the config the server read, through
 * the page, to the row's mark.
 *
 * The supervisor's test: as Owner, `PUT /api/agents/settings/sla
 * {enabled:true, slaMinutes:30, warningThreshold:70}` → 200; a fresh load of
 * `/he/inbox?view=mine`. The BFF read the setting back (54 bytes,
 * enabled:true) and the list row was Omer's own - assigned to him, last
 * message INBOUND, `waitingSince` 2026-07-30, no department. No mark.
 *
 * Only the network is mocked: the real `loadSlaSettings`/`loadSlaClock`, the
 * real page, the real list, the real mark. The row is the API's, parsed by
 * the real contract.
 */
const { get, loadInbox } = vi.hoisted(() => ({ get: vi.fn(), loadInbox: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/features/inbox/load-inbox', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadInbox,
}));
vi.mock('@/features/inbox/load-clear-queue', () => ({ loadClearQueue: vi.fn() }));
vi.mock('@/features/inbox/load-filter-chips', async () => ({
  loadFilterChips: async () => (await import('@/features/inbox/inbox-views')).FALLBACK_FILTER_CHIPS,
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  redirect: vi.fn(),
  Link: ({
    href,
    children,
    prefetch: _p,
    ...rest
  }: {
    href: unknown;
    children: ReactNode;
    prefetch?: unknown;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'inbox' | 'channels' | 'navigation') =>
    createTranslator({ locale: 'en', messages: { inbox, channels, navigation }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
  getLocale: async () => 'en',
}));

/* The 54 bytes the BFF read: `{"enabled":true,"slaMinutes":30,"warningThreshold":70}`. */
const SLA_ON = { enabled: true, slaMinutes: 30, warningThreshold: 70 };

/* Omer's row, as GET /api/conversations sent it (the fields that matter). */
const omersRow = (handledBy: string | null) =>
  conversationRowSchema.parse({
    id: 'cms7no7qk',
    status: 'OPEN',
    channel: 'WHATSAPP',
    handledBy,
    assignedAgentId: 'me',
    assignedAiAgentId: null,
    isHandedOver: true,
    departmentId: null,
    customerName: 'Omer Serruya',
    lastMessageBody: 'הייי',
    lastMessageDirection: 'INBOUND',
    lastMessageAt: '2026-10-11T13:43:00.000Z',
    createdAt: '2026-07-30T08:00:00.000Z',
    waitingSince: '2026-07-30T09:00:00.000Z',
    unread: true,
    unreadCount: 1,
  });

const listProps = (tree: ReactNode) => {
  // Assigned in the walk's closure: a plain `null` initialiser narrows to never.
  let props = null as Record<string, unknown> | null;
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === ConversationList) props = element.props as Record<string, unknown>;
    walk(element.props?.children);
  };
  walk(tree);
  return props;
};

const load = async (handledBy: string | null, sla: unknown) => {
  get.mockReset();
  get.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
    if (endpoint.path === '/api/agents/settings/sla') {
      if (sla instanceof Error) throw sla;
      return sla;
    }
    throw new Error(`unexpected read ${endpoint.path}`);
  });
  const row = omersRow(handledBy);
  loadInbox.mockResolvedValue({
    rows: [row],
    hasMore: false,
    nextCursor: null,
    undatedCount: 0,
    open: null,
    missing: null,
    meId: 'me',
    colleagues: [],
    greeting: null,
    detail: null,
  });
  const tree = await Page({ searchParams: Promise.resolve({ view: 'mine' }) });
  const props = listProps(tree);
  expect(props, 'the page mounts the list').not.toBeNull();
  render(
    <NextIntlClientProvider locale="en" messages={{ inbox, common }}>
      {await ConversationList(props as unknown as Parameters<typeof ConversationList>[0])}
    </NextIntlClientProvider>,
  );
  return props!;
};

/*
 * The page is imported once, with time to spare: cold, it pulls in the whole
 * inbox, and under a full parallel run that alone passed the 5s test budget -
 * and the timed-out test then rendered into the next one.
 */
let Page: typeof PageType;
beforeAll(async () => {
  Page = (await import('./page')).default;
}, 60_000);

describe('★★ dev, 2026-10-12: SLA on, Omer’s waiting row - marked, end to end', () => {
  it.each(['ai_agent', 'human', null])(
    '★★ handledBy %s, assigned and handed over: late - the page passes the clock and the row shows it',
    async (handledBy) => {
      const props = await load(handledBy, SLA_ON);
      expect(props.sla).toEqual({ minutes: 30, warningPercent: 70, departments: {} });
      expect(screen.getByTestId('sla-cms7no7qk')).toHaveAttribute('data-sla', 'late');
      expect(screen.getByTestId('sla-cms7no7qk')).toHaveTextContent('Past SLA');
    },
  );

  it('SLA off: nothing', async () => {
    const props = await load('ai_agent', { ...SLA_ON, enabled: false });
    expect(props.sla).toBeNull();
    expect(screen.queryByTestId('sla-cms7no7qk')).toBeNull();
  });

  it('★ not an Owner (a 403 until Backend b8360b3b): nothing', async () => {
    const props = await load('ai_agent', new ApiError({ status: 403, kind: 'authorization' }));
    expect(props.sla).toBeNull();
    expect(screen.queryByTestId('sla-cms7no7qk')).toBeNull();
  });
});
