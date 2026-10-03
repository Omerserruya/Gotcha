import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import knowledge from '@/i18n/messages/en/knowledge.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ADD_WAYS, AddKnowledge, isAddWay, type AddWay } from './AddKnowledge';

const sheet = (initialWay?: AddWay) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ knowledge }}>
      <AddKnowledge initialWay={initialWay} />
    </NextIntlClientProvider>,
  );

describe('★★ 08b — the ways in the platform has, and nothing that sends', () => {
  it('five ways, document first and chosen — no product catalogue (Omer, 2026-09-26)', () => {
    sheet();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('data-testid'))).toEqual(
      ADD_WAYS.map((w) => `add-way-${w}`),
    );
    expect(screen.getByTestId('add-way-document')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/catalogue/i)).toBeNull();
  });

  it('says only what the platform reads: no spreadsheet, no Dropbox', () => {
    sheet();
    expect(screen.getByTestId('add-way-document')).toHaveTextContent(
      'PDF, Word or text · up to 10 MB',
    );
    expect(screen.getByTestId('add-way-drive')).toHaveTextContent('Google Drive or Confluence');
    expect(document.body.textContent).not.toMatch(/spreadsheet|Dropbox/i);
  });

  it.each([
    ['document', 'add-drop'],
    ['page', 'add-read'],
    ['drive', 'add-connect-google_drive'],
    ['text', 'add-teach'],
  ] as const)('%s: its control is drawn, not live, with the reason', (way, id) => {
    sheet(way);
    expect(screen.getByTestId(id)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId(id)).toHaveAttribute(
      'title',
      expect.stringMatching(/waiting for approval/),
    );
  });

  it('choosing a way and typing stay local', async () => {
    sheet();
    await userEvent.click(screen.getByTestId('add-way-text'));
    expect(screen.getByTestId('add-sheet')).toHaveAttribute('data-way', 'text');
    await userEvent.type(screen.getByTestId('add-body'), 'Trade discount is 40%');
    expect(screen.getByTestId('add-body')).toHaveValue('Trade discount is 40%');
    await userEvent.click(screen.getByTestId('add-way-page'));
    await userEvent.type(screen.getByTestId('add-url'), 'https://example.com/terms');
    expect(screen.getByTestId('add-url')).toHaveValue('https://example.com/terms');
  });

  it('from a conversation: "—", and where past conversations are learned', () => {
    sheet('conversation');
    expect(screen.getByTestId('add-pin')).toHaveTextContent('—');
    expect(screen.getByTestId('add-pin')).toHaveAttribute(
      'title',
      expect.stringMatching(/history import in Settings · Channels/),
    );
  });

  it('★ "What it learned" is drawn in its shape, with no invented facts', () => {
    sheet();
    const card = screen.getByTestId('add-learned');
    expect(card).toHaveTextContent('What it learned');
    expect(screen.getByTitle(/Nothing previews what a source teaches/)).toHaveTextContent('—');
    expect(card.textContent).not.toMatch(/New|Disagrees|Replaces/);
  });

  it('only a known way opens on its card', () => {
    expect(isAddWay('drive')).toBe(true);
    expect(isAddWay('catalogue')).toBe(false);
    expect(isAddWay(undefined)).toBe(false);
  });
});
