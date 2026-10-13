import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { knowledgeDocumentDetailSchema } from '@/api/contracts/knowledge';
import en from '@/i18n/messages/en/knowledge.json';
import he from '@/i18n/messages/he/knowledge.json';

/* They write the knowledge every employee answers from: spies, always. */
const saveDocument = vi.hoisted(() => vi.fn());
const deleteDocument = vi.hoisted(() => vi.fn());
vi.mock('./document-actions', () => ({ saveDocument, deleteDocument }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => router }));

import { DocumentActions } from './DocumentActions';
import { editableOf } from './document-edit';

/** The route's own shape (`knowledge.ts` GET), through the real contract. */
const doc = (over: Record<string, unknown> = {}) =>
  editableOf(
    knowledgeDocumentDetailSchema.parse({
      id: 'd1',
      knowledgeBaseId: 'kb-1',
      title: 'Shipping terms',
      type: 'text',
      content: 'We ship in 2 days.',
      contentLength: 18,
      truncated: false,
      metadata: null,
      ...over,
    }),
  );

beforeEach(() => {
  saveDocument.mockReset();
  deleteDocument.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
});

const show = (over: Record<string, unknown> = {}, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ knowledge: locale === 'he' ? he : en }}>
      <DocumentActions document={doc(over)}>
        <div data-testid="doc-body">the read view</div>
      </DocumentActions>
    </NextIntlClientProvider>,
  );
const press = (testId: string) =>
  act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
const save = () =>
  act(async () => {
    fireEvent.submit(screen.getByTestId('doc-edit'));
  });
const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('★★ K11 - a typed item is edited in place: title and content', () => {
  it('Edit opens the text editor over the body, from what is stored; Save sends the changes', async () => {
    saveDocument.mockResolvedValueOnce({ ok: true, reprocessing: true });
    show();
    expect(screen.getByTestId('doc-body')).toBeInTheDocument();
    await press('doc-edit-open');
    expect(screen.queryByTestId('doc-body')).toBeNull();
    expect(screen.getByTestId('doc-edit-title')).toHaveValue('Shipping terms');
    expect(screen.getByTestId('doc-edit-content')).toHaveValue('We ship in 2 days.');
    // A typed item has no line about where it came from.
    expect(screen.queryByTestId('doc-edit-note')).toBeNull();
    // Nothing changed: nothing to save.
    expect(screen.getByTestId('doc-edit-save')).toBeDisabled();

    type('doc-edit-title', 'Shipping and returns');
    type('doc-edit-content', 'We ship in 2 days.\nReturns within 14 days.');
    expect(saveDocument).not.toHaveBeenCalled();
    await save();
    expect(saveDocument).toHaveBeenCalledWith('kb-1', 'd1', {
      title: 'Shipping and returns',
      content: 'We ship in 2 days.\nReturns within 14 days.',
    });
    // Back to the body, which is read again, and the saved line says what happens now.
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.getByTestId('doc-body')).toBeInTheDocument();
    expect(screen.getByTestId('doc-saved')).toHaveTextContent(
      "Saved. GOTCHA is reading the new text, and answers from it once that's done.",
    );
  });

  it('a title alone: only the title is sent, and "Saved." - nothing is being read again', async () => {
    saveDocument.mockResolvedValueOnce({ ok: true, reprocessing: false });
    show();
    await press('doc-edit-open');
    type('doc-edit-title', 'Terms');
    await save();
    expect(saveDocument).toHaveBeenCalledWith('kb-1', 'd1', { title: 'Terms' });
    expect(screen.getByTestId('doc-saved')).toHaveTextContent(/^Saved\.$/);
  });

  it('Cancel leaves the editor with nothing written, and the next Edit starts from what is stored', async () => {
    show();
    await press('doc-edit-open');
    type('doc-edit-title', 'Half-typed');
    await press('doc-edit-cancel');
    expect(saveDocument).not.toHaveBeenCalled();
    expect(screen.getByTestId('doc-body')).toBeInTheDocument();
    expect(screen.getByTestId('doc-edit-open')).toHaveFocus();
    await press('doc-edit-open');
    expect(screen.getByTestId('doc-edit-title')).toHaveValue('Shipping terms');
  });

  it.each([
    ['forbidden', 'You need permission to change what GOTCHA knows.'],
    ['failed', "It wasn't saved. Try again."],
    ['gone', "This item isn't in your knowledge any more."],
    ['empty_content', 'Write its content first. To remove the item, delete it.'],
  ])('refused %s: said in words, the draft kept', async (reason, words) => {
    saveDocument.mockResolvedValueOnce({ ok: false, reason });
    show();
    await press('doc-edit-open');
    type('doc-edit-content', 'Next day.');
    await save();
    expect(screen.getByTestId('doc-edit-problem')).toHaveTextContent(words);
    expect(screen.getByTestId('doc-edit-content')).toHaveValue('Next day.');
    expect(screen.queryByTestId('doc-saved')).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('★★ K11 - a website or file item says what an edit is', () => {
  it.each([
    ['a page the scan crawled', 'url_text'],
    ['a scan summary', 'onboarding_scan'],
  ])('★ %s: the edit is kept through the next scan - Backend’s words', async (_, type) => {
    show({ type, metadata: { origin: 'onboarding', dedupeKey: 'url:x' } });
    await press('doc-edit-open');
    expect(screen.getByTestId('doc-edit-content')).toBeInTheDocument();
    expect(screen.getByTestId('doc-edit-note')).toHaveTextContent(
      /^A manual edit is kept through the next scan\.$/,
    );
  });

  it('★ in Hebrew, Backend’s sentence as given', async () => {
    show({ type: 'url_text', metadata: { origin: 'onboarding' } }, 'he');
    await press('doc-edit-open');
    expect(screen.getByTestId('doc-edit-note')).toHaveTextContent(
      /^עריכה ידנית נשמרת גם בסריקה הבאה\.$/,
    );
  });

  it('★ a title-only scan item still says so: the title is kept through the scan too', async () => {
    show({ type: 'url_text', truncated: true, metadata: { origin: 'onboarding' } });
    await press('doc-edit-open');
    expect(screen.queryByTestId('doc-edit-content')).toBeNull();
    expect(screen.getByTestId('doc-edit-note')).toHaveAttribute('data-note', 'scan');
  });

  it('a page added by hand, and a file: the text GOTCHA took, not the page or the file', async () => {
    show({ type: 'url', sourceUrl: 'https://shop.example.com/terms' });
    await press('doc-edit-open');
    expect(screen.getByTestId('doc-edit-note')).toHaveTextContent(
      "You're changing the text GOTCHA took from the page. The page itself stays as it is.",
    );
  });

  it('a file', async () => {
    show({ type: 'file' });
    await press('doc-edit-open');
    expect(screen.getByTestId('doc-edit-note')).toHaveTextContent(
      "You're changing the text GOTCHA took from the file. Your file stays as it is.",
    );
  });

  it('★ longer than the drawer holds: the title only, said - no content field to cut it with', async () => {
    saveDocument.mockResolvedValueOnce({ ok: true, reprocessing: false });
    show({ type: 'file', truncated: true, contentLength: 50000 });
    await press('doc-edit-open');
    expect(screen.queryByTestId('doc-edit-content')).toBeNull();
    expect(screen.getByTestId('doc-edit-title-only')).toHaveTextContent(
      'This item is too long to edit here, so only its title can be changed.',
    );
    // The file line is about its text, which is not editable here.
    expect(screen.queryByTestId('doc-edit-note')).toBeNull();
    type('doc-edit-title', 'Catalogue 2026');
    await save();
    expect(saveDocument).toHaveBeenCalledWith('kb-1', 'd1', { title: 'Catalogue 2026' });
  });

  it.each([
    ['google_drive', 'Google Drive'],
    ['confluence', 'Confluence'],
  ])('★ %s: no Edit, no Delete - only where it is changed', (type, place) => {
    show({ type });
    expect(screen.queryByTestId('doc-edit-open')).toBeNull();
    expect(screen.queryByTestId('doc-delete-open')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('doc-synced')).toHaveTextContent(
      `GOTCHA keeps this item in step with ${place}, so it's changed or removed in ${place}.`,
    );
    expect(screen.getByTestId('doc-body')).toBeInTheDocument();
  });
});

describe('★★ K11 - delete asks first, naming the item', () => {
  it('Delete asks; "Keep it" writes nothing and goes back', async () => {
    show();
    await press('doc-delete-open');
    expect(screen.getByTestId('doc-delete-what')).toHaveTextContent(
      'Delete „Shipping terms”? GOTCHA stops using it.',
    );
    expect(screen.getByTestId('doc-delete-keep')).toHaveFocus();
    expect(deleteDocument).not.toHaveBeenCalled();
    await press('doc-delete-keep');
    expect(screen.queryByTestId('doc-delete-confirm')).toBeNull();
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByTestId('doc-delete-open')).toHaveFocus();
  });

  it('confirmed: the DELETE goes, and the drawer closes to the list - as its × does', async () => {
    deleteDocument.mockResolvedValueOnce({ ok: true });
    show();
    await press('doc-delete-open');
    await press('doc-delete-yes');
    expect(deleteDocument).toHaveBeenCalledWith('kb-1', 'd1');
    expect(router.push).toHaveBeenCalledWith('/studio/knowledge');
  });

  it.each([
    ['forbidden', 'You need permission to delete from what GOTCHA knows.'],
    ['failed', "It wasn't deleted. Try again."],
  ])('refused %s: said, and the drawer stays', async (reason, words) => {
    deleteDocument.mockResolvedValueOnce({ ok: false, reason });
    show();
    await press('doc-delete-open');
    await press('doc-delete-yes');
    expect(screen.getByTestId('doc-delete-problem')).toHaveTextContent(words);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('in Hebrew, the name in „…” and set apart in its own direction', async () => {
    show({ title: 'Shipping terms' }, 'he');
    await press('doc-delete-open');
    const what = screen.getByTestId('doc-delete-what');
    expect(what).toHaveTextContent('למחוק את „Shipping terms”? GOTCHA תפסיק להשתמש בו.');
    expect(what.querySelector('bdi[dir="auto"]')).toHaveTextContent(/^Shipping terms$/);
  });
});
