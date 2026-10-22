import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelSchema, voiceChannelSchema } from '@/api/contracts/channels';
import channels from '@/i18n/messages/en/channels.json';
import common from '@/i18n/messages/en/common.json';
import heChannels from '@/i18n/messages/he/channels.json';

/**
 * The connected row's Disconnect, through the real list and the real
 * confirmation. The server action is mocked and throws unless a test says
 * otherwise: no test here can disconnect anything.
 */

const { disconnectChannel, refresh } = vi.hoisted(() => ({
  disconnectChannel: vi.fn(async (_id: string): Promise<unknown> => {
    throw new Error('a test must never disconnect a channel for real');
  }),
  refresh: vi.fn(),
}));
vi.mock('./disconnect-actions', () => ({ disconnectChannel }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels') =>
    createTranslator({ locale: 'en', messages: { channels, common }, namespace }),
  getLocale: async () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, ...rest }: { children: ReactNode; href: unknown }) => (
    <a {...rest} href="#">
      {children}
    </a>
  ),
  useRouter: () => ({ refresh }),
}));
vi.mock('./ConnectableRow', () => ({ ConnectableRow: () => null }));

import { ChannelList } from './ChannelList';

const account = (id: string, type: string, status = 'CONNECTED', displayName?: string) =>
  channelSchema.parse({ id, channel: type, connectionStatus: status, displayName });

async function list(rows: ReturnType<typeof account>[], voice = [] as unknown[]) {
  const ui = await ChannelList({
    channels: rows,
    voice: voice.map((v) => voiceChannelSchema.parse(v)),
    voiceOffered: true,
    windowDays: 30,
  });
  return render(
    <NextIntlClientProvider locale="en" messages={{ channels, common }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  disconnectChannel.mockReset();
  disconnectChannel.mockImplementation(async () => {
    throw new Error('a test must never disconnect a channel for real');
  });
  refresh.mockClear();
});

describe('★★ a connected channel can be disconnected from its row', () => {
  it.each([
    ['INSTAGRAM', 'Instagram'],
    ['MESSENGER', 'Messenger'],
    ['GMAIL', 'Gmail'],
    ['OUTLOOK', 'Outlook'],
    ['SLACK', 'Slack'],
    ['EMAIL', 'Email'],
  ])('%s: a Disconnect button where "Nothing to set" was', async (type) => {
    await list([account('c1', type)]);
    const button = screen.getByTestId('channel-disconnect-c1');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveTextContent('Disconnect');
    // A mailbox has its template beside it (2026-10-22); the rest have nothing to set.
    if (['GMAIL', 'OUTLOOK', 'EMAIL'].includes(type)) {
      expect(screen.getByTestId('channel-settings-c1').tagName).toBe('A');
    } else {
      expect(screen.queryByTestId('channel-settings-c1')).toBeNull();
    }
  });

  it('the button opens a confirmation in the channel’s name - nothing is sent yet', async () => {
    await list([account('ig1', 'INSTAGRAM', 'CONNECTED', '@shop')]);
    await userEvent.click(screen.getByTestId('channel-disconnect-ig1'));
    const dialog = await screen.findByTestId('channel-disconnect-confirm-ig1');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Disconnect Instagram?');
    expect(dialog).toHaveTextContent(
      'Messages from Instagram will stop reaching GOTCHA. The conversations you already have are kept.',
    );
    expect(dialog).toHaveTextContent('@shop');
    expect(disconnectChannel).not.toHaveBeenCalled();
  });

  it('confirming disconnects THAT account, then the list is read again', async () => {
    disconnectChannel.mockResolvedValueOnce({ ok: true });
    await list([account('ig1', 'INSTAGRAM'), account('g1', 'GMAIL')]);
    await userEvent.click(screen.getByTestId('channel-disconnect-ig1'));
    await userEvent.click(await screen.findByTestId('channel-disconnect-yes-ig1'));
    expect(disconnectChannel).toHaveBeenCalledTimes(1);
    expect(disconnectChannel).toHaveBeenCalledWith('ig1');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('channel-disconnect-confirm-ig1')).toBeNull();
  });

  it('Cancel sends nothing', async () => {
    await list([account('e1', 'EMAIL')]);
    await userEvent.click(screen.getByTestId('channel-disconnect-e1'));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('channel-disconnect-confirm-e1')).toBeNull();
    expect(disconnectChannel).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', "This channel isn't connected here any more."],
    ['forbidden', "You don't have permission to disconnect this channel."],
    ['failed', "It wasn't disconnected. Try again in a moment."],
  ])('a refusal (%s) is said in words, and the confirmation stays', async (reason, words) => {
    disconnectChannel.mockResolvedValueOnce({ ok: false, reason });
    await list([account('s1', 'SLACK')]);
    await userEvent.click(screen.getByTestId('channel-disconnect-s1'));
    await userEvent.click(await screen.findByTestId('channel-disconnect-yes-s1'));
    const said = await screen.findByTestId('channel-disconnect-failed-s1');
    expect(said).toHaveAttribute('role', 'alert');
    expect(said).toHaveTextContent(words);
    expect(screen.getByTestId('channel-disconnect-confirm-s1')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('★ where the route does not apply, the row keeps a status', () => {
  it('voice (another spine, no channel account) stays "Nothing to set"', async () => {
    await list([], [{ id: 'v1', status: 'ACTIVE', numbers: [] }]);
    expect(screen.queryByTestId('channel-disconnect-v1')).toBeNull();
    const status = screen.getByTestId('channel-settings-v1');
    expect(status.closest('a,button')).toBeNull();
    expect(status).toHaveAttribute('aria-disabled', 'true');
  });

  it('a mailbox already disconnected offers no second Disconnect, and its template still opens', async () => {
    await list([account('e1', 'EMAIL', 'DISCONNECTED')]);
    expect(screen.queryByTestId('channel-disconnect-e1')).toBeNull();
    expect(screen.getByTestId('channel-settings-e1').tagName).toBe('A');
  });

  it('WhatsApp keeps its Settings (13b, where numbers are disconnected one by one)', async () => {
    await list([account('w1', 'WHATSAPP')]);
    expect(screen.queryByTestId('channel-disconnect-w1')).toBeNull();
    expect(screen.getByTestId('channel-settings-w1').tagName).toBe('A');
  });

  it('the Website widget keeps its Settings - no Disconnect on it', async () => {
    await list([account('wc1', 'WEBCHAT')]);
    expect(screen.queryByTestId('channel-disconnect-wc1')).toBeNull();
    expect(screen.getByTestId('channel-settings-widget').tagName).toBe('A');
  });
});

describe('the copy', () => {
  it('Hebrew: a non-breaking hyphen joins מ to the channel’s name', () => {
    expect(heChannels.disconnect.what).toBe(
      'לא יתקבלו יותר הודעות מ‑{channel}, והשיחות שכבר יש נשמרות.',
    );
  });
});

describe('★ a mailbox address in the row (React #418 behind Cloudflare, dev 2026-10-22)', () => {
  it('reaches the server’s HTML with no email pattern in it, and reads the same', async () => {
    const { renderToString } = await import('react-dom/server');
    const ui = await ChannelList({
      channels: [account('g1', 'GMAIL', 'CONNECTED', 'hello@shop.test')],
      voice: [],
      voiceOffered: true,
      windowDays: 30,
    });
    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={{ channels, common }}>
        {ui}
      </NextIntlClientProvider>,
    );
    expect(html).not.toContain('hello@shop.test');
    expect(html).toContain('hello<!-- -->@<!-- -->shop.test');
    await list([account('g1', 'GMAIL', 'CONNECTED', 'hello@shop.test')]);
    expect(screen.getByTestId('channel-detail-g1')).toHaveTextContent(/^hello@shop\.test/);
  });
});
