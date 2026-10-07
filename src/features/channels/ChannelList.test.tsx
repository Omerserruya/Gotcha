import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { channelSchema } from '@/api/contracts/channels';
import { widgetInstallSchema } from '@/api/contracts/website-widget';
import channels from '@/i18n/messages/en/channels.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels') =>
    createTranslator({ locale: 'en', messages: { channels }, namespace }),
  getLocale: async () => 'en',
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
          : `${href.pathname}${href.query ? `?${new URLSearchParams(href.query)}` : ''}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));
const rowProps = vi.hoisted(() => [] as { channel: string; notSetUp?: boolean }[]);
vi.mock('./ConnectableRow', () => ({
  ConnectableRow: (props: { channel: string; notSetUp?: boolean }) => {
    rowProps.push(props);
    return null;
  },
}));

import { ChannelList } from './ChannelList';

const channel = (id: string, type: string) =>
  channelSchema.parse({ id, channel: type, connectionStatus: 'CONNECTED' });

describe('★ 13b is reached from its row on 13, now that it is not a section', () => {
  it('every row has 02’s "Settings"; only WhatsApp’s leads anywhere (13b)', async () => {
    render(
      await ChannelList({
        channels: [channel('w1', 'WHATSAPP'), channel('e1', 'EMAIL')],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    expect(screen.getByTestId('channel-settings-w1')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp',
    );
    const email = screen.getByTestId('channel-settings-e1');
    expect(email).not.toHaveAttribute('href');
    expect(email).toHaveAttribute('aria-disabled', 'true');
    expect(email).toHaveAttribute('title', expect.stringMatching(/come next/i));
  });
});

describe('★ 13 - the warning above the list, and who answers on the line', () => {
  it('a troubled channel raises the banner, in the platform’s own words', async () => {
    render(
      await ChannelList({
        channels: [
          channelSchema.parse({
            id: 'w1',
            channel: 'WHATSAPP',
            connectionStatus: 'ERROR',
            lastError: 'No payment method on the WhatsApp Business account.',
          }),
        ],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    const banner = screen.getByTestId('channel-banner');
    expect(banner).toHaveTextContent('WhatsApp needs attention');
    expect(banner).toHaveTextContent('No payment method on the WhatsApp Business account.');
  });

  it('no trouble, no banner; and no "who answers" on the row - not the channel\'s to say', async () => {
    render(
      await ChannelList({
        channels: [
          channelSchema.parse({
            id: 'e1',
            channel: 'EMAIL',
            connectionStatus: 'CONNECTED',
          }),
        ],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    expect(screen.queryByTestId('channel-banner')).toBeNull();
    expect(screen.getByTestId('channel-detail-e1')).not.toHaveTextContent(/answers|with AI help/i);
  });
});

describe('★ 13 corrections (measurement of 9b8dd9f)', () => {
  it('★★ a troubled row says "Needs attention", never "Connected" - the words on its title', async () => {
    render(
      await ChannelList({
        channels: [
          channelSchema.parse({
            id: 's1',
            channel: 'SHOPIFY_LIVE_CHAT',
            connectionStatus: 'CONNECTED',
            lastError: 'Shopify Chat app was uninstalled from the store.',
          }),
        ],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    // dev's Shopify chat: CONNECTED and uninstalled - on the widget's one row now.
    const chip = screen.getByTestId('channel-status-widget');
    expect(chip).toHaveTextContent('Needs attention');
    expect(chip).toHaveAttribute('title', 'Shopify Chat app was uninstalled from the store.');
    // The row stays a row: the banner tells it, not a second red line.
    expect(screen.getByTestId('channel-widget')).not.toHaveTextContent(/uninstalled/);
    // And the banner names the product, not a channel that is gone from the list.
    expect(screen.getByTestId('channel-banner')).toHaveTextContent('Website widget');
    expect(screen.getByTestId('channel-banner')).not.toHaveTextContent('Shopify live chat');
    // Troubled heads the list.
    expect(screen.getByTestId('channel-list').firstElementChild).toBe(
      screen.getByTestId('channel-widget'),
    );
  });

  it('every row has its tile, so the names line up', async () => {
    const { container } = render(
      await ChannelList({
        channels: [
          channelSchema.parse({ id: 'e1', channel: 'EMAIL', connectionStatus: 'CONNECTED' }),
        ],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    expect(container.querySelector('[data-kind="connected"] [data-tone="email"]')).not.toBeNull();
  });
});

describe('★ a provider with no app on the server is said up front, not after a click', () => {
  it('outlook: false → not set up; the rest, and unread, stay live', async () => {
    rowProps.length = 0;
    render(
      await ChannelList({
        channels: [],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
        providers: { outlook: false, gmail: true },
      }),
    );
    const of = (c: string) => rowProps.find((p) => p.channel === c)?.notSetUp;
    expect(of('OUTLOOK')).toBe(true);
    expect(of('GMAIL')).toBe(false);
    expect(of('SLACK')).toBe(false); // not in the map: unknown, so live
    expect(of('EMAIL')).toBe(false); // no OAuth at all
    rowProps.length = 0;
    render(await ChannelList({ channels: [], voice: [], voiceOffered: false, windowDays: 30 }));
    expect(rowProps.every((p) => p.notSetUp === false)).toBe(true);
  });
});

describe('★★ the Website widget is ONE row: the web chat and every Shopify chat (Omer, 2026-10-07)', () => {
  const webchat = () =>
    channelSchema.parse({
      id: 'wc1',
      channel: 'WEBCHAT',
      connectionStatus: 'PENDING',
      externalId: 'widget_64aba7ec',
      _count: { conversations: 2 },
      conversationsInWindow: 10,
    });
  const shopChat = () =>
    channelSchema.parse({
      id: 'sc1',
      channel: 'SHOPIFY_LIVE_CHAT',
      connectionStatus: 'CONNECTED',
      displayName: 'lumiere.myshopify.com',
      _count: { conversations: 3 },
      conversationsInWindow: 30,
    });
  const install = (over: Record<string, unknown> = {}) =>
    widgetInstallSchema.parse({
      data: {
        code: {
          widgetId: 'widget_64aba7ec',
          snippet: '<script></script>',
          status: 'not_seen',
          lastHost: null,
        },
        shopify: [],
        woocommerce: { status: 'use_code' },
        ...over,
      },
    }).data;
  const list = async (
    rows: ReturnType<typeof webchat>[],
    read: ReturnType<typeof install> | null,
  ) =>
    render(
      await ChannelList({
        channels: rows,
        voice: [],
        voiceOffered: false,
        windowDays: 30,
        install: read,
      }),
    );

  it('★★ both accounts are one row, named once, its Settings the widget’s page', async () => {
    await list([webchat(), shopChat()], install());
    expect(screen.getAllByTestId('channel-widget')).toHaveLength(1);
    expect(screen.queryByTestId('channel-wc1')).toBeNull();
    expect(screen.queryByTestId('channel-sc1')).toBeNull();
    expect(screen.getByTestId('channel-widget')).toHaveTextContent('Website widget');
    expect(screen.getByTestId('channel-widget')).not.toHaveTextContent(
      /Web chat|Shopify live chat/,
    );
    expect(screen.getByTestId('channel-settings-widget')).toHaveAttribute(
      'href',
      '/settings/channels/website',
    );
  });

  it('★ the line: where it runs, then the two measures summed over its places', async () => {
    await list(
      [webchat(), shopChat()],
      install({
        code: { widgetId: 'w', snippet: 's', status: 'live', lastHost: 'avivco.il' },
      }),
    );
    expect(screen.getByTestId('channel-detail-widget')).toHaveTextContent(
      'lumiere.myshopify.com · avivco.il · 5 open now · 40 started in the last 30 days',
    );
    // The widget id is not a place.
    expect(screen.getByTestId('channel-detail-widget')).not.toHaveTextContent('widget_');
  });

  it('★★ live is the installs’ to say: the code seen, or a shop whose theme loads it', async () => {
    const one = await list([webchat()], install());
    expect(screen.getByTestId('channel-status-widget')).toHaveTextContent('Not live yet');
    one.unmount();
    await list(
      [shopChat()],
      install({
        code: null,
        shopify: [
          {
            channelId: 'sc1',
            shopDomain: 'lumiere.myshopify.com',
            status: 'active',
            embedLive: true,
          },
        ],
      }),
    );
    expect(screen.getByTestId('channel-status-widget')).toHaveTextContent(/^Live$/);
  });

  it('⚠ installs unread: the accounts’ own status, never a guess of "Live"', async () => {
    await list([webchat(), shopChat()], null);
    expect(screen.getByTestId('channel-status-widget')).toHaveTextContent('Connected');
    expect(screen.getByTestId('channel-status-widget')).not.toHaveTextContent(/^Live$/);
  });

  it('★ installed nowhere: still the row, saying so - and no "Connect web chat" beside it', async () => {
    rowProps.length = 0;
    await list([], null);
    expect(screen.getByTestId('channel-detail-widget')).toHaveTextContent(
      'Not installed anywhere yet',
    );
    expect(screen.getByTestId('channel-status-widget')).toHaveTextContent('Not live yet');
    expect(rowProps.map((p) => p.channel)).not.toContain('WEBCHAT');
    expect(rowProps.map((p) => p.channel)).not.toContain('SHOPIFY_LIVE_CHAT');
  });
});
