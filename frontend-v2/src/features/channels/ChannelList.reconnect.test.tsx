import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelSchema } from '@/api/contracts/channels';
import channels from '@/i18n/messages/en/channels.json';
import common from '@/i18n/messages/en/common.json';
import heCommon from '@/i18n/messages/he/common.json';

/**
 * A row that is connected but cannot receive: its Reconnect, through the real
 * list. The connect start is mocked and throws unless a test says otherwise:
 * no test here opens a provider for real.
 */

const { startChannelConnect, assign } = vi.hoisted(() => ({
  startChannelConnect: vi.fn(async (_channel: string): Promise<unknown> => {
    throw new Error('a test must never start a connect for real');
  }),
  assign: vi.fn(),
}));
vi.mock('./actions', () => ({ startChannelConnect }));
vi.mock('./disconnect-actions', () => ({ disconnectChannel: vi.fn() }));
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
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('./ConnectableRow', () => ({ ConnectableRow: () => null }));

import { ChannelList } from './ChannelList';

const account = (id: string, type: string, status: string, code: string | null) =>
  channelSchema.parse({
    id,
    channel: type,
    connectionStatus: status,
    displayName: 'Shop page',
    lastError: code ? 'the provider said no' : null,
    lastErrorCode: code,
  });

async function list(rows: ReturnType<typeof account>[]) {
  const ui = await ChannelList({ channels: rows, voice: [], voiceOffered: false, windowDays: 30 });
  return render(
    <NextIntlClientProvider locale="en" messages={{ channels, common }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  startChannelConnect.mockReset();
  startChannelConnect.mockImplementation(async () => {
    throw new Error('a test must never start a connect for real');
  });
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});

describe('★★ connected, but messages cannot arrive: said, and Reconnect beside Disconnect', () => {
  it('Messenger PENDING with SUBSCRIBE_FAILED: the banner says why, the row offers Reconnect', async () => {
    await list([account('p1', 'MESSENGER', 'PENDING', 'SUBSCRIBE_FAILED')]);
    expect(screen.getByTestId('channel-banner')).toHaveTextContent(
      common.platformError.subscribe_failed,
    );
    expect(screen.getByTestId('channel-status-p1')).toHaveTextContent('Needs attention');
    const row = screen.getByTestId('channel-p1');
    expect(within(row).getByTestId('channel-reconnect-p1')).toHaveTextContent('Reconnect');
    expect(within(row).getByTestId('channel-disconnect-p1')).toBeInTheDocument();
    // The provider's own sentence is never printed.
    expect(row).not.toHaveTextContent('the provider said no');
  });

  it('Reconnect runs THIS channel’s Connect and goes to the provider', async () => {
    startChannelConnect.mockResolvedValueOnce({ ok: true, url: 'https://www.facebook.com/dialog' });
    await list([account('g1', 'GMAIL', 'CONNECTED', 'WATCH_FAILED')]);
    await userEvent.click(screen.getByTestId('channel-reconnect-g1'));
    expect(startChannelConnect).toHaveBeenCalledTimes(1);
    expect(startChannelConnect).toHaveBeenCalledWith('GMAIL');
    expect(assign).toHaveBeenCalledWith('https://www.facebook.com/dialog');
  });

  it.each([
    ['not_configured', "Outlook isn't set up on GOTCHA's side yet."],
    ['forbidden', "You don't have permission to connect a channel."],
    ['failed', "Outlook couldn't be opened - try again."],
  ])('a refusal (%s) is said in words, and nothing navigates', async (reason, words) => {
    startChannelConnect.mockResolvedValueOnce({ ok: false, reason });
    await list([account('o1', 'OUTLOOK', 'CONNECTED', 'OUTLOOK_SUBSCRIPTION_FAILED')]);
    await userEvent.click(screen.getByTestId('channel-reconnect-o1'));
    const said = await screen.findByTestId('channel-reconnect-problem-o1');
    expect(said).toHaveAttribute('role', 'alert');
    expect(said).toHaveTextContent(words);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a healthy row, or one another error troubles, has no Reconnect', async () => {
    await list([
      account('ok1', 'INSTAGRAM', 'CONNECTED', null),
      account('t1', 'SLACK', 'ERROR', null),
    ]);
    expect(screen.queryByTestId('channel-reconnect-ok1')).toBeNull();
    expect(screen.queryByTestId('channel-reconnect-t1')).toBeNull();
    expect(screen.getByTestId('channel-disconnect-ok1')).toBeInTheDocument();
  });
});

describe('the copy', () => {
  it('Hebrew: the supervisor’s sentence, GOTCHA joined by a non-breaking hyphen', () => {
    expect(heCommon.platformError.subscribe_failed).toBe(
      'מחובר, אבל הודעות לא מגיעות: הפלטפורמה לא אישרה ל‑GOTCHA לקבל אותן. מחברים מחדש כדי לנסות שוב.',
    );
  });
});
