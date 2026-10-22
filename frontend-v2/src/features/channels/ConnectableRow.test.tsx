import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/channels.json';
import { expectStretchedRow, tabStops } from '@/test/stretched-row';

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
