import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { channelSchema } from '@/api/contracts/channels';
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
vi.mock('./WebChatEmbed', () => ({
  WebChatEmbed: ({ widgetId }: { widgetId: string }) => (
    <pre data-testid="embed-open">{widgetId}</pre>
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

  it('no trouble, no banner; who answers is the line’s end, not a column', async () => {
    render(
      await ChannelList({
        channels: [
          channelSchema.parse({
            id: 'e1',
            channel: 'EMAIL',
            connectionStatus: 'CONNECTED',
            responseMode: 'AI_AUTO_REPLY',
          }),
        ],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    expect(screen.queryByTestId('channel-banner')).toBeNull();
    expect(screen.getByTestId('channel-detail-e1')).toHaveTextContent('AI answers automatically');
  });
});

describe('★ 13 corrections (measurement of 9b8dd9f)', () => {
  it('★★ a troubled row says "Needs attention", never "Connected" - the words on its title', async () => {
    render(
      await ChannelList({
        channels: [
          channelSchema.parse({
            id: 's1',
            channel: 'WEBCHAT',
            connectionStatus: 'CONNECTED',
            lastError: 'Shopify Chat app was uninstalled from the store.',
          }),
        ],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
      }),
    );
    const chip = screen.getByTestId('channel-status-s1');
    expect(chip).toHaveTextContent('Needs attention');
    expect(chip).toHaveAttribute('title', 'Shopify Chat app was uninstalled from the store.');
    // The row stays a row: the banner tells it, not a second red line.
    expect(screen.getByTestId('channel-s1')).not.toHaveTextContent(/uninstalled/);
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
    expect(of('WEBCHAT')).toBe(false); // no OAuth at all
    rowProps.length = 0;
    render(await ChannelList({ channels: [], voice: [], voiceOffered: false, windowDays: 30 }));
    expect(rowProps.every((p) => p.notSetUp === false)).toBe(true);
  });
});

describe('★★ web chat’s Settings is its embed code - reachable any time after Create', () => {
  const webchat = () =>
    channelSchema.parse({
      id: 'wc1',
      channel: 'WEBCHAT',
      connectionStatus: 'PENDING',
      externalId: 'widget_64aba7ec',
    });

  it('Settings opens it on the row (?embed=); open, it closes it', async () => {
    const one = render(
      await ChannelList({ channels: [webchat()], voice: [], voiceOffered: false, windowDays: 30 }),
    );
    expect(screen.getByTestId('channel-settings-wc1')).toHaveAttribute(
      'href',
      '/settings/channels?embed=wc1',
    );
    expect(screen.queryByTestId('embed-open')).toBeNull();
    one.unmount();
    render(
      await ChannelList({
        channels: [webchat()],
        voice: [],
        voiceOffered: false,
        windowDays: 30,
        embed: 'wc1',
      }),
    );
    expect(screen.getByTestId('embed-open')).toHaveTextContent('widget_64aba7ec');
    // The row stays a row; the code wraps onto its own full line beneath it.
    expect(screen.getByTestId('channel-wc1').className).toMatch(/rowWithEmbed/);
    expect(screen.getByTestId('channel-settings-wc1')).toHaveAttribute(
      'href',
      '/settings/channels',
    );
  });
});
