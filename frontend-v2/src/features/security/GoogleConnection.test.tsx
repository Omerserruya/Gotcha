import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import he from '@/i18n/messages/he/security.json';

const disconnectGoogle = vi.hoisted(() => vi.fn());
vi.mock('./google-actions', () => ({ disconnectGoogle }));

const { GoogleConnection } = await import('./GoogleConnection');

type Card = Parameters<typeof GoogleConnection>[0]['card'];
const read = (over: Record<string, unknown> = {}): Card => ({
  kind: 'read',
  google: {
    available: true,
    connected: true,
    email: 'maya@avivco.il',
    connectedAt: '2026-11-22T10:00:00Z',
    canDisconnect: true,
    reason: null,
    ...over,
  },
});

const show = (card: Card, marker: 'connected' | 'other_account' | null = null) =>
  render(
    <NextIntlClientProvider locale="he" messages={{ security: he }}>
      <GoogleConnection
        card={card}
        marker={marker}
        connectGo={<button type="button" data-testid="google-connect-go" />}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  disconnectGoogle.mockReset().mockResolvedValue('disconnected');
});

describe('★★ חשבונות מחוברים', () => {
  it('★ unread says so, and never "not connected"', () => {
    show({ kind: 'unread' });
    expect(screen.getByTestId('google-unread')).toHaveTextContent(he.google.unread);
    expect(screen.queryByText(he.google.notConnected)).toBeNull();
  });

  it('★★ connected: the address, isolated left-to-right, and "ניתוק"', () => {
    show(read());
    const detail = screen.getByTestId('google-detail');
    expect(detail).toHaveTextContent('maya@avivco.il');
    expect(detail.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('google-disconnect')).toHaveTextContent('ניתוק');
  });

  it('★★ not connected: "לא מחובר" and "חיבור"', () => {
    show(read({ connected: false, email: null, canDisconnect: false }));
    expect(screen.getByTestId('google-detail')).toHaveTextContent('לא מחובר');
    expect(screen.getByTestId('google-connect')).toHaveTextContent('חיבור');
  });

  it('⚠⚠ Google the only way in (Backend’s rule): the reason, and no control to press', () => {
    show(read({ canDisconnect: false, reason: 'no_other_sign_in' }));
    expect(screen.queryByTestId('google-disconnect')).toBeNull();
    expect(screen.getByTestId('google-refused')).toHaveTextContent(he.google.refused);
  });

  it('★★ disconnect asks first, inline, then removes', async () => {
    show(read());
    await userEvent.click(screen.getByTestId('google-disconnect'));
    expect(screen.getByTestId('google-disconnect-confirm')).toHaveTextContent(
      he.google.confirmDisconnect,
    );
    expect(disconnectGoogle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('google-disconnect-go'));
    await waitFor(() => expect(disconnectGoogle).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('google-done')).toHaveTextContent(he.google.disconnected);
    expect(screen.getByTestId('google-detail')).toHaveTextContent('לא מחובר');
  });

  it('★ cancel closes the confirm and removes nothing', async () => {
    show(read());
    await userEvent.click(screen.getByTestId('google-disconnect'));
    await userEvent.click(screen.getByTestId('google-cancel'));
    expect(screen.queryByTestId('google-disconnect-confirm')).toBeNull();
    expect(disconnectGoogle).not.toHaveBeenCalled();
  });

  it('⚠⚠ refused at the server (409): the reason, the connection still shown', async () => {
    disconnectGoogle.mockResolvedValue('refused');
    show(read());
    await userEvent.click(screen.getByTestId('google-disconnect'));
    await userEvent.click(screen.getByTestId('google-disconnect-go'));
    expect(await screen.findByTestId('google-refused')).toHaveTextContent(he.google.refused);
    expect(screen.getByTestId('google-detail')).toHaveTextContent('maya@avivco.il');
  });

  it('⚠ a failure says so', async () => {
    disconnectGoogle.mockResolvedValue('failed');
    show(read());
    await userEvent.click(screen.getByTestId('google-disconnect'));
    await userEvent.click(screen.getByTestId('google-disconnect-go'));
    expect(await screen.findByTestId('google-failed')).toHaveTextContent(he.google.failed);
  });

  it('★★ connect asks first, in Omer’s words, and ends in the shell’s button', async () => {
    show(read({ connected: false, email: null }));
    await userEvent.click(screen.getByTestId('google-connect'));
    expect(screen.getByTestId('google-connect-confirm')).toHaveTextContent(
      he.google.confirmConnect,
    );
    expect(screen.getByTestId('google-connect-go')).toBeInTheDocument();
  });

  it.each([
    ['connected', 'google-done', he.google.connected],
    ['other_account', 'google-other-account', he.google.otherAccount],
  ] as const)('★ the callback’s %s says one line', (marker, testid, words) => {
    show(read(), marker);
    expect(screen.getByTestId(testid)).toHaveTextContent(words);
  });
});
