import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import knowledge from '@/i18n/messages/en/knowledge.json';

import type * as AddKnowledgeModule from './add-knowledge';

const refresh = vi.hoisted(() => vi.fn());
/* Adding writes knowledge every AI employee answers from: the write is a spy. */
const addKnowledge = vi.hoisted(() => vi.fn());
vi.mock('./add-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof AddKnowledgeModule>()),
  addKnowledge,
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
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

import { ADD_WAYS, isAddWay, type AddWay, type KnowledgeBaseRef } from './add-way';
import { AddKnowledge } from './AddKnowledge';

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

  it('drive: drawn, with why — its way back still leads to the previous app', () => {
    sheet('drive');
    expect(screen.getByTestId('add-connect-google_drive')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('add-connect-google_drive')).toHaveAttribute(
      'title',
      expect.stringMatching(/previous app/),
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

describe('★★ 08b live (Omer, 2026-10-04) — and nothing is sent without the button', () => {
  const live = (initialWay?: AddWay, base: KnowledgeBaseRef = { id: 'kb1' }) =>
    render(
      <NextIntlClientProvider locale="en" messages={{ knowledge }}>
        <AddKnowledge initialWay={initialWay} base={base} />
      </NextIntlClientProvider>,
    );
  beforeEach(() => {
    addKnowledge.mockReset();
    refresh.mockReset();
  });

  it('a typed fact: Teach waits for both; then it is added, said as being read', async () => {
    addKnowledge.mockResolvedValue({ ok: true, title: 'Trade discount', status: 'pending' });
    live('text');
    expect(screen.getByTestId('add-teach')).toBeDisabled();
    await userEvent.type(screen.getByTestId('add-title'), 'Trade discount');
    expect(screen.getByTestId('add-teach')).toBeDisabled();
    await userEvent.type(screen.getByTestId('add-body'), '40% from 12 units');
    expect(addKnowledge).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('add-teach'));
    expect(addKnowledge).toHaveBeenCalledWith(
      { id: 'kb1' },
      { way: 'text', title: 'Trade discount', body: '40% from 12 units' },
      'Knowledge',
    );
    // Being read — never "learned": the platform embeds it in the background.
    expect(screen.getByTestId('add-added')).toHaveTextContent('Trade discount');
    expect(screen.getByTestId('add-added')).toHaveTextContent('Being read');
    expect(refresh).toHaveBeenCalled();
  });

  it('a page: Read waits for an http(s) address', async () => {
    addKnowledge.mockResolvedValue({ ok: false, reason: 'unreadable' });
    live('page');
    await userEvent.type(screen.getByTestId('add-url'), 'not a url');
    expect(screen.getByTestId('add-read')).toBeDisabled();
    await userEvent.clear(screen.getByTestId('add-url'));
    await userEvent.type(screen.getByTestId('add-url'), 'https://shop.example.com/terms');
    await userEvent.click(screen.getByTestId('add-read'));
    expect(addKnowledge).toHaveBeenCalledWith(
      { id: 'kb1' },
      { way: 'page', url: 'https://shop.example.com/terms' },
      'Knowledge',
    );
    expect(screen.getByTestId('add-problem')).toHaveTextContent('There was no text to read in it.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a document: what the platform reads, up to 10 MB — anything else refused here', async () => {
    addKnowledge.mockResolvedValue({ ok: true, title: 'Terms', status: 'pending' });
    live('document');
    const picker = screen.getByTestId('add-file');
    await userEvent.upload(picker, new File(['x'], 'photo.png', { type: 'image/png' }), {
      applyAccept: false,
    });
    expect(screen.getByTestId('add-problem')).toHaveTextContent(
      'PDF, Word, Markdown or text only.',
    );
    expect(screen.getByTestId('add-teach')).toBeDisabled();
    const pdf = new File(['%PDF'], 'Autumn terms.pdf', { type: 'application/pdf' });
    await userEvent.upload(picker, pdf);
    expect(screen.getByTestId('add-file-name')).toHaveTextContent('Autumn terms.pdf');
    await userEvent.click(screen.getByTestId('add-teach'));
    expect(addKnowledge).toHaveBeenCalledWith(
      { id: 'kb1' },
      { way: 'document', file: pdf },
      'Knowledge',
    );
  });
});
