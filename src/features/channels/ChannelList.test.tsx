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
vi.mock('./ConnectableRow', () => ({ ConnectableRow: () => null }));

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

describe('★ 13 — the warning above the list, and who answers on the line', () => {
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
