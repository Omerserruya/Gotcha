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
const startKnowledgeConnect = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
/* After-connect sources read the network; they have their own tests. */
vi.mock('./ConnectedSources', () => ({ ConnectedSources: () => null }));
vi.mock('./add-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof AddKnowledgeModule>()),
  addKnowledge,
  startKnowledgeConnect,
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh, replace }),
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

import {
  ADD_WAYS,
  isAddWay,
  type AddWay,
  type KnowledgeBaseRef,
  type KnowledgeLanding,
} from './add-way';
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

describe('★★ Drive and Confluence — at the provider, and back here (backend df9ee4cd)', () => {
  const assign = vi.fn();
  beforeEach(() => {
    startKnowledgeConnect.mockReset();
    replace.mockReset();
    assign.mockReset();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign },
    });
  });
  const drive = (landing: KnowledgeLanding | null = null) => (
    <NextIntlClientProvider locale="en" messages={{ knowledge }}>
      <AddKnowledge initialWay="drive" base={{ id: 'kb1' }} landing={landing} />
    </NextIntlClientProvider>
  );

  it('Connect asks for the provider’s page, then goes there — only on the click', async () => {
    startKnowledgeConnect.mockResolvedValue({
      ok: true,
      url: 'https://accounts.google.com/o/oauth2/auth?x',
    });
    render(drive());
    expect(startKnowledgeConnect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('add-connect-google_drive'));
    expect(startKnowledgeConnect).toHaveBeenCalledWith({ id: 'kb1' }, 'google_drive', 'Knowledge');
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x');
  });

  it('a refusal is said; nothing opened', async () => {
    startKnowledgeConnect.mockResolvedValue({ ok: false, reason: 'forbidden' });
    render(drive());
    await userEvent.click(screen.getByTestId('add-connect-confluence'));
    expect(screen.getByTestId('add-connect-problem')).toHaveTextContent(
      'Only an admin can connect a knowledge source.',
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('each source carries its mark (Omer, 10): Drive’s logo; Confluence, which has none, the plug', () => {
    render(drive());
    const row = (id: string) => screen.getByTestId(id).closest('li')!;
    expect(row('add-connect-google_drive').querySelector('img')?.getAttribute('src')).toMatch(
      /\/integrations\/google_drive\.svg$/,
    );
    expect(row('add-connect-confluence').querySelector('img')).toBeNull();
    expect(row('add-connect-confluence').querySelector('svg')).not.toBeNull();
  });

  it('no way back: the URL is left alone', () => {
    render(drive(null));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('add-landing')).toBeNull();
  });

  it('★ the way back is said once, and outlives the tidied URL', async () => {
    const { rerender } = render(drive({ connector: 'google_drive', outcome: 'denied' }));
    expect(replace).toHaveBeenCalledWith(
      { pathname: '/studio/knowledge', query: { add: '1', way: 'drive' } },
      { scroll: false },
    );
    rerender(drive(null));
    expect(screen.getByTestId('add-landing')).toHaveTextContent(
      'You cancelled at Google — nothing was connected.',
    );
  });

  it.each([
    [{ connector: 'confluence', outcome: 'connected' }, 'Confluence is connected.'],
    [
      { connector: 'confluence', outcome: 'no_accessible_site' },
      'No Confluence site you can reach',
    ],
    [{ connector: 'google_drive', outcome: 'other' }, "Google Drive didn't connect."],
  ] as const)('%o → %s', (landing, words) => {
    render(drive(landing));
    expect(screen.getByTestId('add-landing')).toHaveTextContent(words);
  });
});
