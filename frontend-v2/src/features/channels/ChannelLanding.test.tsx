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
  messengerPickOf,
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
      { channel: 'INSTAGRAM', outcome: 'connected', count: 1, pending: false, reason: null },
    ],
    [
      { connected: 'whatsapp', count: '2', pending: '1' },
      { channel: 'WHATSAPP', outcome: 'connected', count: 2, pending: true, reason: null },
    ],
    [
      { connected: 'gmail' },
      { channel: 'GMAIL', outcome: 'connected', count: null, pending: false, reason: null },
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
    // ★ v1's way back (dev's v1 paths 302 here since 2026-10-09)
    [
      { connected: 'whatsapp', pending: 'true' },
      { channel: 'WHATSAPP', outcome: 'connected', count: null, pending: true, reason: null },
    ],
    [{ error: 'no_whatsapp_numbers' }, { channel: 'WHATSAPP', outcome: 'no_whatsapp_numbers' }],
    [{ error: 'gmail_already_connected' }, { channel: 'GMAIL', outcome: 'already_connected' }],
    [{ error: 'slack_token_failed' }, { channel: 'SLACK', outcome: 'token_exchange_failed' }],
    [{ error: 'connection_failed' }, { channel: null, outcome: 'callback_error' }],
    [{ error: 'access_denied' }, { channel: null, outcome: 'denied' }],
    [{ error: 'invalid_state' }, { channel: null, outcome: 'invalid_state' }],
    // A provider's own words: never shown - "didn't connect".
    [{ error: 'The user denied your request.' }, { channel: null, outcome: 'other' }],
    // ★ A pending connect that is not WhatsApp's: Messenger's or Instagram's refused subscription.
    [
      { connected: 'messenger', count: '2', pending: '1', reason: 'SUBSCRIBE_FAILED' },
      {
        channel: 'MESSENGER',
        outcome: 'connected',
        count: 2,
        pending: true,
        reason: 'subscribe_failed',
      },
    ],
    [
      { platform: 'instagram', pending: '1', reason: 'SUBSCRIBE_FAILED' },
      {
        channel: 'INSTAGRAM',
        outcome: 'connected',
        count: null,
        pending: true,
        reason: 'subscribe_failed',
      },
    ],
    // A code nobody knows here is no reason; a reason on a finished connect is ignored.
    [
      { connected: 'messenger', pending: '1', reason: 'toString' },
      { channel: 'MESSENGER', outcome: 'connected', count: null, pending: true, reason: null },
    ],
    [
      { connected: 'messenger', reason: 'SUBSCRIBE_FAILED' },
      { channel: 'MESSENGER', outcome: 'connected', count: null, pending: false, reason: null },
    ],
    // `platform=` names a connect only when it is pending; with `error=` it is a failure.
    [
      { platform: 'instagram', pending: '1', error: 'denied' },
      { channel: 'INSTAGRAM', outcome: 'denied' },
    ],
    // ★ Backend 0ce84f21: Messenger over the plan's limit, and choices not kept.
    [
      { platform: 'messenger', error: 'limit_reached' },
      { channel: 'MESSENGER', outcome: 'limit_reached' },
    ],
    [
      { platform: 'messenger', error: 'picker_failed' },
      { channel: 'MESSENGER', outcome: 'picker_failed' },
    ],
    [{ error: 'picker_failed' }, { channel: 'MESSENGER', outcome: 'picker_failed' }],
    [{ error: 'limit_reached' }, { channel: null, outcome: 'limit_reached' }],
    // The picker's way back is not a sentence: nothing connected, nothing failed.
    [{ pick: '1', platform: 'messenger', session: 's1' }, null],
  ])('%o', (params, landing) => {
    expect(channelLandingOf(params)).toEqual(landing);
  });
});

describe('★★ said once, and the URL tidied', () => {
  it('"Instagram connected - 1 account."; the list stays the list', () => {
    show({ channel: 'INSTAGRAM', outcome: 'connected', count: 1, pending: false, reason: null });
    expect(screen.getByTestId('channel-landing')).toHaveTextContent(
      'Instagram connected - 1 account.',
    );
    expect(replace).toHaveBeenCalledWith('/settings/channels', { scroll: false });
  });

  it('WhatsApp connected: back to its panel, 13b', () => {
    show({ channel: 'WHATSAPP', outcome: 'connected', count: 1, pending: false, reason: null });
    expect(replace).toHaveBeenCalledWith('/settings/channels?panel=whatsapp', { scroll: false });
  });

  it('★ a refused subscription is said as one: connected, nothing arrives, reconnect from the row', () => {
    show({
      channel: 'MESSENGER',
      outcome: 'connected',
      count: 1,
      pending: true,
      reason: 'subscribe_failed',
    });
    const said = screen.getByTestId('channel-landing');
    expect(said).toHaveTextContent(
      "Messenger is connected, but messages can't arrive: the platform refused GOTCHA's subscription to them. Reconnect it from its row below.",
    );
    expect(said).not.toHaveTextContent(/Meta needs one more step/);
    expect(replace).toHaveBeenCalledWith('/settings/channels', { scroll: false });
  });

  it('pending with no known reason: WhatsApp keeps its Meta step; any other channel points at its row', () => {
    const one = show({
      channel: 'WHATSAPP',
      outcome: 'connected',
      count: null,
      pending: true,
      reason: null,
    });
    expect(screen.getByTestId('channel-landing')).toHaveTextContent(
      'WhatsApp is connected, and Meta needs one more step',
    );
    one.unmount();
    show({ channel: 'INSTAGRAM', outcome: 'connected', count: null, pending: true, reason: null });
    const said = screen.getByTestId('channel-landing');
    expect(said).toHaveTextContent(
      "Instagram is connected, but it isn't ready for messages yet. Its row below says what it needs.",
    );
    expect(said).not.toHaveTextContent(/Meta|number/);
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

describe('★★ v1’s way back with no channel: said, in a sentence that needs none', () => {
  it('★ a raw provider text is never printed; the sentence names no channel', () => {
    show(channelLandingOf({ error: 'Error validating verification code <script>' })!);
    const said = screen.getByTestId('channel-landing');
    expect(said).toHaveTextContent("The connection didn't go through. Try again.");
    expect(said).not.toHaveTextContent(/verification|script|Another channel/);
  });

  it('every failure with no channel reads without one', () => {
    for (const code of [...CHANNEL_CONNECT_FAILURES, 'other'] as const) {
      const { unmount } = show({ channel: null, outcome: code });
      const text = screen.getByTestId('channel-landing').textContent ?? '';
      expect(text).not.toMatch(/landing\.|error\.|unnamed\.|Another channel/);
      unmount();
    }
  });
});

describe('★★ Messenger’s picker way back (backend 0ce84f21)', () => {
  it.each([
    [{ pick: '1', platform: 'messenger', session: 'abc-123' }, { session: 'abc-123' }],
    [{ pick: '1', platform: 'messenger', session: ' abc ' }, { session: 'abc' }],
    [{ pick: '1', platform: 'messenger' }, null],
    [{ pick: '1', platform: 'messenger', session: '' }, null],
    [{ pick: '1', platform: 'messenger', session: 'x'.repeat(101) }, null],
    // Only Messenger keeps Pages to choose from.
    [{ pick: '1', platform: 'instagram', session: 'abc' }, null],
    [{ pick: '1', session: 'abc' }, null],
    [{ pick: '0', platform: 'messenger', session: 'abc' }, null],
    [{ platform: 'messenger', session: 'abc' }, null],
  ])('%o', (params, pick) => {
    expect(messengerPickOf(params)).toEqual(pick);
  });

  it('limit_reached and picker_failed are said in words, named and unnamed', () => {
    const one = show({ channel: 'MESSENGER', outcome: 'limit_reached' });
    expect(screen.getByTestId('channel-landing')).toHaveTextContent(
      "Your plan has no room for another channel, so Messenger wasn't connected.",
    );
    one.unmount();
    const two = show({ channel: 'MESSENGER', outcome: 'picker_failed' });
    expect(screen.getByTestId('channel-landing')).toHaveTextContent(
      "Your Pages couldn't be kept for you to choose from, so nothing was connected. Connect Messenger again.",
    );
    two.unmount();
    show({ channel: null, outcome: 'limit_reached' });
    expect(screen.getByTestId('channel-landing')).toHaveTextContent(
      'Your plan has no room for another channel, so nothing was connected.',
    );
  });
});
