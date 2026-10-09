import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/channels.json';

const replace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace }) }));

import { ChannelLanding } from './ChannelLanding';
import {
  CHANNEL_CONNECT_FAILURES,
  channelLandingOf,
  type ChannelLanding as Landing,
} from './landing';

beforeEach(() => {
  replace.mockReset();
});
const show = (landing: Landing) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <ChannelLanding landing={landing} />
    </NextIntlClientProvider>,
  );

describe('★★ the way back, read off the URL', () => {
  it.each([
    [
      { connected: 'instagram', count: '1' },
      { channel: 'INSTAGRAM', outcome: 'connected', count: 1, pending: false },
    ],
    [
      { connected: 'whatsapp', count: '2', pending: '1' },
      { channel: 'WHATSAPP', outcome: 'connected', count: 2, pending: true },
    ],
    [
      { connected: 'gmail' },
      { channel: 'GMAIL', outcome: 'connected', count: null, pending: false },
    ],
    [
      { platform: 'slack', error: 'denied' },
      { channel: 'SLACK', outcome: 'denied' },
    ],
    [
      { platform: 'slack', error: 'made_up' },
      { channel: 'SLACK', outcome: 'other' },
    ],
    [{ connected: 'myspace' }, null],
    [{ platform: 'gmail' }, null],
    [{}, null],
  ])('%o', (params, landing) => {
    expect(channelLandingOf(params)).toEqual(landing);
  });
});

describe('★★ said once, and the URL tidied', () => {
  it('"Instagram connected - 1 account."; the list stays the list', () => {
    show({ channel: 'INSTAGRAM', outcome: 'connected', count: 1, pending: false });
    expect(screen.getByTestId('channel-landing')).toHaveTextContent(
      'Instagram connected - 1 account.',
    );
    expect(replace).toHaveBeenCalledWith('/settings/channels', { scroll: false });
  });

  it('WhatsApp connected: back to its panel, 13b', () => {
    show({ channel: 'WHATSAPP', outcome: 'connected', count: 1, pending: false });
    expect(replace).toHaveBeenCalledWith('/settings/channels?panel=whatsapp', { scroll: false });
  });

  it('nothing to say: nothing drawn, the URL left alone', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <ChannelLanding landing={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('channel-landing')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a failure is said in the warm tone; it outlives the tidy (re-rendered with null)', () => {
    const { rerender } = show({ channel: 'MESSENGER', outcome: 'no_pages' });
    expect(screen.getByTestId('channel-landing')).toHaveAttribute('data-outcome', 'problem');
    rerender(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <ChannelLanding landing={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('channel-landing')).toHaveTextContent(
      'No Facebook Page came with that sign-in',
    );
  });

  it('every code the backend can send has its own sentence', () => {
    for (const code of [...CHANNEL_CONNECT_FAILURES, 'other'] as const) {
      const { unmount } = show({ channel: 'GMAIL', outcome: code });
      // A missing message renders its key path: assert the sentence, not a length.
      expect(screen.getByTestId('channel-landing').textContent).not.toMatch(/landing\.|error\./);
      expect(messages.landing.error).toHaveProperty(code);
      unmount();
    }
  });
});
