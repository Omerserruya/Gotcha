import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { channelSchema, voiceChannelSchema } from '@/api/contracts/channels';
import type { VoiceErrorReason } from '@/api/contracts/platform-errors';
import { widgetInstallSchema } from '@/api/contracts/website-widget';
import channels from '@/i18n/messages/en/channels.json';
import common from '@/i18n/messages/en/common.json';
import heChannels from '@/i18n/messages/he/channels.json';
import heCommon from '@/i18n/messages/he/common.json';

/* The page's language, per test: the channel words and the shared error words. */
const lang = vi.hoisted(() => ({ he: false }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels') =>
    createTranslator({
      locale: lang.he ? 'he' : 'en',
      messages: lang.he ? { channels: heChannels, common: heCommon } : { channels, common },
      namespace,
    }),
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

/* The row's Disconnect is a client component with its own test (ChannelList.disconnect). */
vi.mock('./DisconnectChannel', () => ({
  DisconnectChannel: ({ id }: { id: string }) => (
    <button data-testid={`channel-disconnect-${id}`} />
  ),
}));

import { ChannelList } from './ChannelList';

const channel = (id: string, type: string) =>
  channelSchema.parse({ id, channel: type, connectionStatus: 'CONNECTED' });

describe('★ 13b is reached from its row on 13, now that it is not a section', () => {
  it('WhatsApp’s "Settings" leads to 13b; a row with nothing to set says so', async () => {
    render(
      await ChannelList({
        channels: [
          channel('w1', 'WHATSAPP'),
          channelSchema.parse({ id: 'e1', channel: 'EMAIL', connectionStatus: 'DISCONNECTED' }),
        ],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    expect(screen.getByTestId('channel-settings-w1')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp',
    );
    // A disconnected mailbox has nothing to set and nothing to disconnect:
    // a status saying so, never a panel.
    expect(screen.queryByTestId('channel-disconnect-e1')).toBeNull();
    const email = screen.getByTestId('channel-settings-e1');
    expect(email).not.toHaveAttribute('href');
    expect(email.closest('a,button')).toBeNull();
    expect(email).toHaveAttribute('aria-disabled', 'true');
    expect(email).toHaveTextContent('Nothing to set');
    expect(email).toHaveAttribute('title', expect.stringMatching(/no settings for this channel/));
  });
});

describe('★ 13 - the warning above the list, and who answers on the line', () => {
  it('a troubled channel raises the banner - an unknown reason said generically, never raw', async () => {
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
    // The platform's sentence is English with no code: never printed under a translated title.
    expect(banner).toHaveTextContent(
      'Something is wrong with this channel. Open it to see what it needs.',
    );
    expect(banner).not.toHaveTextContent('No payment method');
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

describe('★★ a voice channel that needs attention says why, in the reader’s words', () => {
  const voiceWith = (healthStatus: string | null, outboundProvisioningFailed: boolean) =>
    ChannelList({
      channels: [],
      voice: [
        voiceChannelSchema.parse({
          id: 'v1',
          status: 'ACTIVE',
          healthStatus,
          config: { outboundProvisioningFailed, outboundProvisioningError: 'RAW TWILIO TEXT' },
          numbers: [{ phoneNumber: '+972 3 000 0000' }],
        }),
      ],
      voiceOffered: true,
      windowDays: 30,
    });

  it('outgoing calls never set up: Needs attention, and the words on its title and banner', async () => {
    render(await voiceWith('ok', true));
    const chip = screen.getByTestId('channel-status-v1');
    expect(chip).toHaveTextContent('Needs attention');
    expect(chip).toHaveAttribute('title', common.platformError.voice_outbound_not_set_up);
    expect(screen.getByTestId('channel-banner')).toHaveTextContent(
      common.platformError.voice_outbound_not_set_up,
    );
    expect(document.body).not.toHaveTextContent('RAW TWILIO TEXT');
  });

  it('a health text it does not know: the generic sentence, never the text', async () => {
    render(await voiceWith('twilio_api_500: RAW TWILIO BODY', false));
    expect(screen.getByTestId('channel-status-v1')).toHaveAttribute(
      'title',
      common.platformError.unknown,
    );
    expect(document.body).not.toHaveTextContent('RAW TWILIO');
  });

  it('every voice reason has words in both languages', () => {
    const reasons: readonly VoiceErrorReason[] = [
      'voice_credentials_unreadable',
      'voice_credentials_rejected',
      'voice_twilio_unreachable',
      'voice_outbound_not_set_up',
    ];
    for (const reason of reasons) {
      expect(common.platformError[reason]).toBeTruthy();
      expect(heCommon.platformError[reason]).toBeTruthy();
    }
  });

  it('Hebrew: the credentials Twilio refused, in Hebrew', async () => {
    lang.he = true;
    try {
      render(await voiceWith('twilio_api_401: x', false));
      expect(screen.getByTestId('channel-status-v1')).toHaveAttribute(
        'title',
        heCommon.platformError.voice_credentials_rejected,
      );
    } finally {
      lang.he = false;
    }
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
    // A known sentence in the reader's words (the supervisor, measured on /he).
    expect(chip).toHaveAttribute(
      'title',
      'The app was removed from the store. Install it again to bring the chat back.',
    );
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
      // dev's account name: the old product's, never a place.
      displayName: 'Shopify Live Chat',
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
        shopify: [
          {
            channelId: 'sc1',
            shopDomain: 'lumiere.myshopify.com',
            status: 'active',
            embedLive: false,
          },
        ],
      }),
    );
    expect(screen.getByTestId('channel-detail-widget')).toHaveTextContent(
      'lumiere.myshopify.com · avivco.il · 5 open now · 40 started in the last 30 days',
    );
    expect(screen.getByTestId('channel-detail-widget')).not.toHaveTextContent('Shopify Live Chat');
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

describe('★★ a channel’s error in the reader’s words - the platform sends English with no code', () => {
  it('Hebrew: the uninstalled app in Hebrew; nothing English under the Hebrew title', async () => {
    lang.he = true;
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
    const banner = screen.getByTestId('channel-banner');
    expect(banner).toHaveTextContent('האפליקציה הוסרה מהחנות. מתקינים אותה מחדש כדי שהצ׳אט יחזור.');
    expect(banner).not.toHaveTextContent(/[A-Za-z]{4,} [a-z]{3,}/);
    lang.he = false;
  });

  it('★★ the code first (auth e28012b0), and a "[CODE] " left on the sentence is read, never printed', async () => {
    const shown = async (over: Record<string, unknown>) => {
      const view = render(
        await ChannelList({
          channels: [
            channelSchema.parse({
              id: 's1',
              channel: 'WHATSAPP',
              connectionStatus: 'ERROR',
              ...over,
            }),
          ],
          voice: [],
          voiceOffered: false,
          windowDays: 30,
        }),
      );
      const text = screen.getByTestId('channel-banner').textContent;
      view.unmount();
      return text;
    };
    const words = 'The app was removed from the store. Install it again to bring the chat back.';
    expect(
      await shown({ lastError: 'reworded later', lastErrorCode: 'SHOPIFY_CHAT_UNINSTALLED' }),
    ).toContain(words);
    const prefixed = await shown({
      lastError: '[SHOPIFY_CHAT_UNINSTALLED] Shopify Chat app was uninstalled from the store.',
    });
    expect(prefixed).toContain(words);
    expect(prefixed).not.toContain('[SHOPIFY');
  });
});
