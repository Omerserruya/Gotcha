import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/channels.json';

const startChannelConnect = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({
  startChannelConnect,
  connectEmail: vi.fn(),
  connectWebChat: vi.fn(),
  setResponseMode: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ConnectPanel } from './ConnectPanel';

const assign = vi.fn();
beforeEach(() => {
  startChannelConnect.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});
const show = (channel: Parameters<typeof ConnectPanel>[0]['channel']) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <ConnectPanel channel={channel} onClose={() => undefined} />
    </NextIntlClientProvider>,
  );

describe('★★ 13 — an OAuth channel connects at its provider (backend ecd64c4d)', () => {
  it.each(['INSTAGRAM', 'MESSENGER', 'GMAIL', 'SLACK', 'OUTLOOK'] as const)(
    '%s: Continue asks for the provider’s page, then goes there — only on the click',
    async (channel) => {
      startChannelConnect.mockResolvedValue({ ok: true, url: 'https://provider.example/auth' });
      show(channel);
      expect(screen.queryByTestId('connect-unavailable')).toBeNull();
      expect(startChannelConnect).not.toHaveBeenCalled();
      await userEvent.click(screen.getByTestId(`connect-oauth-${channel}`));
      expect(startChannelConnect).toHaveBeenCalledWith(channel);
      expect(assign).toHaveBeenCalledWith('https://provider.example/auth');
    },
  );

  it('not set up on the server (409): said, nothing opened', async () => {
    startChannelConnect.mockResolvedValue({ ok: false, reason: 'not_configured' });
    show('OUTLOOK');
    await userEvent.click(screen.getByTestId('connect-oauth-OUTLOOK'));
    expect(screen.getByTestId('connect-problem')).toHaveTextContent(
      "Outlook isn't set up on GOTCHA's side yet.",
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('WhatsApp: to 13c’s sheet, not straight to Meta', () => {
    show('WHATSAPP');
    expect(screen.getByTestId('connect-whatsapp-sheet')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp&view=connect',
    );
    expect(screen.queryByTestId('connect-oauth-WHATSAPP')).toBeNull();
  });
});

describe('★ the row itself: "Not set up yet" in place of Connect', () => {
  it('no button to press; the reason on its title', async () => {
    const { ConnectableRow } = await import('./ConnectableRow');
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <ConnectableRow channel="OUTLOOK" notSetUp />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('connect-open-OUTLOOK')).toBeNull();
    expect(screen.getByTestId('connect-not-set-up-OUTLOOK')).toHaveTextContent('Not set up yet');
    expect(screen.getByTestId('connect-not-set-up-OUTLOOK').getAttribute('title')).toMatch(
      /Outlook isn't set up on GOTCHA's side yet/,
    );
  });
});
