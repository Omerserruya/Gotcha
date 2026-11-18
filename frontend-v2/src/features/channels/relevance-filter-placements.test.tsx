import { render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelSchema } from '@/api/contracts/channels';
import { numbersResponseSchema } from '@/api/contracts/whatsapp-numbers';
import channels from '@/i18n/messages/en/channels.json';
import common from '@/i18n/messages/en/common.json';

/**
 * ★★ Where the relevance filter's switch is drawn (Supervisior, 2026-11-18):
 * on each WhatsApp number in 13b, on an Instagram or Messenger row, and
 * NOWHERE ELSE on the list (a mailbox's is in its drawer: page.test). Only for
 * a boolean value, and only while INBOX_RELEVANCE is on. The switch itself is
 * stubbed: it has its own test.
 */

const flag = vi.hoisted(() => ({ on: true }));
vi.mock('@/api/client/inbox-relevance', () => ({ inboxRelevanceOn: () => flag.on }));
vi.mock('./RelevanceFilterSwitch', () => ({
  RelevanceFilterSwitch: ({
    channelAccountId,
    enabled,
    layout = 'block',
  }: {
    channelAccountId: string;
    enabled: boolean;
    layout?: string;
  }) => (
    <span
      data-testid={`stub-filter-${channelAccountId}`}
      data-enabled={String(enabled)}
      data-layout={layout}
    />
  ),
}));
vi.mock('./disconnect-actions', () => ({
  disconnectChannel: async () => {
    throw new Error('a test must never disconnect a channel for real');
  },
}));
vi.mock('./ConnectableRow', () => ({ ConnectableRow: () => null }));
vi.mock('./ModeSwitch', () => ({ ModeSwitch: () => null }));
vi.mock('./PrimaryNumber', () => ({ PrimaryNumber: () => null }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels') =>
    createTranslator({ locale: 'en', messages: { channels, common }, namespace }),
  getLocale: async () => 'en',
  getTimeZone: async () => 'Asia/Jerusalem',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, ...rest }: { children: ReactNode; href: unknown }) => (
    <a {...rest} href="#">
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: () => {} }),
}));

import { ChannelList } from './ChannelList';
import { relevanceFiltersOf } from './rows';
import { WhatsAppNumbers } from './WhatsAppNumbers';

const account = (id: string, type: string, relevanceFilterEnabled?: boolean | null) =>
  channelSchema.parse({ id, channel: type, connectionStatus: 'CONNECTED', relevanceFilterEnabled });

async function list(rows: ReturnType<typeof account>[]) {
  const ui = await ChannelList({ channels: rows, voice: [], voiceOffered: false, windowDays: 30 });
  return render(
    <NextIntlClientProvider locale="en" messages={{ channels, common }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  flag.on = true;
});

describe('★★ the contract: relevanceFilterEnabled', () => {
  it.each([
    [true, true],
    [false, false],
    [null, null],
    [undefined, null],
    ['yes', null],
  ] as const)('%s reads as %s, and the row still parses', (sent, read) => {
    expect(account('ca1', 'INSTAGRAM', sent as never).relevanceFilterEnabled ?? null).toBe(read);
  });
});

describe('★★ on the channel list', () => {
  it.each(['INSTAGRAM', 'MESSENGER'])('%s: on its row, inline, with its value', async (type) => {
    await list([account('ca1', type, false)]);
    const stub = within(screen.getByTestId('channel-ca1')).getByTestId('stub-filter-ca1');
    expect(stub).toHaveAttribute('data-enabled', 'false');
    expect(stub).toHaveAttribute('data-layout', 'inline');
  });

  it.each(['WHATSAPP', 'GMAIL', 'OUTLOOK'])(
    '%s: never on the row (13b or the mailbox drawer holds it)',
    async (type) => {
      await list([account('ca1', type, true)]);
      expect(screen.queryByTestId('stub-filter-ca1')).toBeNull();
    },
  );

  it.each([null, undefined])('a value of %s draws nothing', async (value) => {
    await list([account('ca1', 'INSTAGRAM', value)]);
    expect(screen.queryByTestId('stub-filter-ca1')).toBeNull();
  });

  it('★★ INBOX_RELEVANCE off: no switch, the row as today', async () => {
    flag.on = false;
    await list([account('ca1', 'INSTAGRAM', true)]);
    expect(screen.queryByTestId('stub-filter-ca1')).toBeNull();
    expect(screen.getByTestId('channel-disconnect-ca1')).toBeInTheDocument();
  });

  it('beside the row’s Disconnect, which stays', async () => {
    await list([account('ca1', 'INSTAGRAM', true)]);
    const row = within(screen.getByTestId('channel-ca1'));
    expect(row.getByTestId('stub-filter-ca1')).toHaveAttribute('data-enabled', 'true');
    expect(row.getByTestId('channel-disconnect-ca1')).toBeInTheDocument();
  });

  it('★ web chat and Slack (null from the backend): never a switch', async () => {
    await list([account('ca1', 'SLACK', null), account('ca2', 'WEBCHAT', null)]);
    expect(screen.queryByTestId(/^stub-filter-/)).toBeNull();
  });
});

describe('★★ on each WhatsApp number (13b)', () => {
  const payload = {
    data: [
      {
        id: 'n1',
        channelAccountId: 'ca1',
        phoneNumber: '+972 50 000 0001',
        name: 'Support',
        state: 'CONNECTED',
        health: { state: 'CONNECTED', receiving: true, sending: true },
      },
      {
        id: 'n2',
        channelAccountId: 'ca2',
        phoneNumber: '+972 50 000 0002',
        name: 'Sales',
        state: 'CONNECTED',
        health: { state: 'CONNECTED', receiving: true, sending: true },
      },
    ],
  };
  const numbers = async (relevanceFilters?: Record<string, boolean> | null) =>
    render(
      await WhatsAppNumbers({ numbers: numbersResponseSchema.parse(payload), relevanceFilters }),
    );

  it('★★ per number: two numbers can differ', async () => {
    await numbers({ ca1: true, ca2: false });
    const [first, second] = screen.getAllByTestId('whatsapp-number');
    expect(within(first!).getByTestId('stub-filter-ca1')).toHaveAttribute('data-enabled', 'true');
    expect(within(second!).getByTestId('stub-filter-ca2')).toHaveAttribute('data-enabled', 'false');
    expect(within(first!).getByTestId('stub-filter-ca1')).toHaveAttribute('data-layout', 'block');
  });

  it('a number the map does not name, or no map (the flag off), draws none', async () => {
    await numbers({ ca1: true });
    expect(screen.getByTestId('stub-filter-ca1')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-filter-ca2')).toBeNull();
  });

  it.each([null, undefined])('relevanceFilters %s: no number draws it', async (map) => {
    await numbers(map);
    expect(screen.queryByTestId(/^stub-filter-/)).toBeNull();
  });

  it('dev’s unprofiled number, by its channel account', async () => {
    render(
      await WhatsAppNumbers({
        numbers: numbersResponseSchema.parse({
          data: [],
          unprofiled: [
            {
              channelAccountId: 'ca9',
              phoneNumberId: 'p9',
              phoneNumber: '+972 50 000 0009',
              connectionStatus: 'CONNECTED',
            },
          ],
        }),
        relevanceFilters: { ca9: true },
      }),
    );
    expect(screen.getByTestId('stub-filter-ca9')).toHaveAttribute('data-enabled', 'true');
  });
});

describe('★★ relevanceFiltersOf: what 13b and the mailbox drawer look up', () => {
  it('each account with a boolean, by id; null and absent left out', () => {
    expect(
      relevanceFiltersOf([
        account('wa1', 'WHATSAPP', true),
        account('wa2', 'WHATSAPP', false),
        account('g1', 'GMAIL', null),
        account('w1', 'WEBCHAT'),
      ]),
    ).toEqual({ wa1: true, wa2: false });
  });
});
