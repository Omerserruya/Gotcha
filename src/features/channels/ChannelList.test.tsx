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
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./ConnectableRow', () => ({ ConnectableRow: () => null }));

import { ChannelList } from './ChannelList';

const channel = (id: string, type: string) =>
  channelSchema.parse({ id, channel: type, connectionStatus: 'CONNECTED' });

describe('★ 13b is reached from its row on 13, now that it is not a section', () => {
  it('the WhatsApp row carries "Settings"; the others do not', async () => {
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
      '/settings/channels/whatsapp',
    );
    expect(screen.queryByTestId('channel-settings-e1')).toBeNull();
  });
});
