import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/channels.json';
import { expectStretchedRow, tabStops } from '@/test/stretched-row';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/* The panel has its own suite; here it only has to be there, with a control. */
vi.mock('./ConnectPanel', () => ({
  ConnectPanel: () => (
    <div data-testid="connect-panel">
      <button type="button">Continue</button>
    </div>
  ),
}));

import { ConnectableRow } from './ConnectableRow';

const show = (notSetUp = false) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
      <ul>
        <ConnectableRow channel="INSTAGRAM" notSetUp={notSetUp} />
      </ul>
    </NextIntlClientProvider>,
  );

describe('★★ a channel to connect: the whole row is its Connect (Omer, 2026-10-11)', () => {
  it('closed: one stretched Connect, the row’s only tab stop', () => {
    show();
    const row = screen.getByTestId('channel-connectable-INSTAGRAM');
    expect(expectStretchedRow(row)).toBe(screen.getByTestId('connect-open-INSTAGRAM'));
  });

  it('open: Connect is gone, so nothing covers the panel’s own controls', async () => {
    show();
    await userEvent.click(screen.getByTestId('connect-open-INSTAGRAM'));
    const row = screen.getByTestId('channel-connectable-INSTAGRAM');
    expect(screen.getByTestId('connect-panel')).toBeInTheDocument();
    expect(tabStops(row)).toEqual([screen.getByRole('button', { name: 'Continue' })]);
  });

  it('not set up on the server: nothing to press, so no stop at all', () => {
    show(true);
    expect(tabStops(screen.getByTestId('channel-connectable-INSTAGRAM'))).toEqual([]);
  });
});

describe('★★ WhatsApp: the row’s Connect opens 13c’s sheet itself (Omer, prod 2026-11-10)', () => {
  /*
   * It opened an inline panel whose only content was a second "Connect" -
   * two buttons for one step, and the second looked broken.
   */
  const showWhatsApp = () =>
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <ul>
          <ConnectableRow channel="WHATSAPP" />
        </ul>
      </NextIntlClientProvider>,
    );

  it('one stretched link, straight to the sheet', () => {
    showWhatsApp();
    const row = screen.getByTestId('channel-connectable-WHATSAPP');
    const link = expectStretchedRow(row);
    expect(link).toBe(screen.getByTestId('connect-open-WHATSAPP'));
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/settings/channels?panel=whatsapp&view=connect');
    expect(link).toHaveTextContent('Connect');
  });

  it('clicking it opens no inline panel', async () => {
    showWhatsApp();
    await userEvent.click(screen.getByTestId('connect-open-WHATSAPP'));
    expect(screen.queryByTestId('connect-panel')).toBeNull();
    expect(screen.getByTestId('connect-open-WHATSAPP')).toBeInTheDocument();
  });

  it('not set up on the server: still "Not set up yet", no link', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ channels: messages }}>
        <ul>
          <ConnectableRow channel="WHATSAPP" notSetUp />
        </ul>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('connect-open-WHATSAPP')).toBeNull();
    expect(screen.getByTestId('connect-not-set-up-WHATSAPP')).toBeInTheDocument();
  });
});
