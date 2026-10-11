import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  knowledgeDocumentDetailSchema,
  type KnowledgeDocumentDetail,
} from '@/api/contracts/knowledge';
import en from '@/i18n/messages/en/knowledge.json';
import he from '@/i18n/messages/he/knowledge.json';

import { DocumentDrawer } from './DocumentDrawer';

/**
 * K6 (Omer, 2026-10-11): one knowledge item's drawer, from ai 67d267f0's
 * `GET /api/knowledge-bases/:id/documents/:docId`. Fed the REAL catalogues,
 * so the assertions read the sentences a person sees.
 */
const lang = vi.hoisted(() => ({ he: false }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'knowledge.doc') =>
    createTranslator({
      locale: lang.he ? 'he' : 'en',
      messages: { knowledge: lang.he ? he : en },
      namespace,
    }),
  getFormatter: async () =>
    createFormatter({ locale: lang.he ? 'he' : 'en', timeZone: 'Asia/Jerusalem' }),
}));

/** The route's own shape (`knowledge.ts`), facts and metadata included. */
const wire = (over: Record<string, unknown> = {}, ai: Record<string, unknown> = {}) => ({
  id: 'd1',
  knowledgeBaseId: 'kb-1',
  title: 'Shipping terms',
  type: 'url',
  sourceUrl: 'https://shop.example.com/terms',
  status: 'ready',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-11T09:00:00.000Z',
  content: 'We ship in 2 days.\nReturns within 14 days.',
  contentLength: 42,
  truncated: false,
  metadata: { origin: 'onboarding' },
  ai: {
    sectionCount: 2,
    sections: [
      { index: 0, length: 18, preview: 'We ship in 2 days.' },
      { index: 1, length: 23, preview: 'משלוח תוך יומיים' },
    ],
    sectionsTruncated: false,
    facts: null,
    ...ai,
  },
  ...over,
});
const doc = (
  over?: Record<string, unknown>,
  ai?: Record<string, unknown>,
): KnowledgeDocumentDetail => knowledgeDocumentDetailSchema.parse(wire(over, ai));

const show = async (read: Parameters<typeof DocumentDrawer>[0]['read']) =>
  render(await DocumentDrawer({ read }));

describe('★★ K6 - what the drawer says about one item', () => {
  it('where it came from (with its address), when it changed, and its state', async () => {
    await show({ state: 'ok', document: doc() });
    expect(screen.getByTestId('doc-source')).toHaveTextContent(
      'A page on your website · https://shop.example.com/terms',
    );
    const link = screen.getByTestId('doc-source-link');
    expect(link).toHaveAttribute('href', 'https://shop.example.com/terms');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('doc-updated')).toHaveTextContent('October 11, 2026');
    expect(screen.getByTestId('doc-status')).toHaveTextContent(/^In use$/);
  });

  it('★ the content is the user’s text: its own direction, kept as written', async () => {
    await show({ state: 'ok', document: doc({ content: 'שלום\nworld' }) });
    const content = screen.getByTestId('doc-content');
    expect(content).toHaveAttribute('dir', 'auto');
    expect(content.textContent).toBe('שלום\nworld');
  });

  it('★★ truncated: says how much of how much', async () => {
    const shown = 'x'.repeat(20000);
    await show({
      state: 'ok',
      document: doc({ content: shown, contentLength: 45210, truncated: true }),
    });
    expect(screen.getByTestId('doc-truncated')).toHaveTextContent(
      'Showing part of the content (20,000 of 45,210 characters)',
    );
  });

  it('whole: no such line', async () => {
    await show({ state: 'ok', document: doc() });
    expect(screen.queryByTestId('doc-truncated')).toBeNull();
  });

  it('★★ what the AI uses: the count and each section’s preview, in its own direction', async () => {
    await show({ state: 'ok', document: doc() });
    expect(screen.getByTestId('doc-ai')).toHaveTextContent('What the AI uses');
    expect(screen.getByTestId('doc-ai-count')).toHaveTextContent(/^2 sections$/);
    expect(screen.getByTestId('doc-section-0')).toHaveTextContent('Section 1We ship in 2 days.');
    const preview = screen.getByTestId('doc-section-1').querySelector('[dir="auto"]');
    expect(preview).toHaveTextContent('משלוח תוך יומיים');
    expect(screen.queryByTestId('doc-ai-more')).toBeNull();
  });

  it('★ more sections than shown: said', async () => {
    await show({ state: 'ok', document: doc({}, { sectionCount: 80, sectionsTruncated: true }) });
    expect(screen.getByTestId('doc-ai-more')).toHaveTextContent(
      'Showing the first 2 of 80 sections.',
    );
  });

  it('★★ facts: null - nothing about facts, never "0 facts"', async () => {
    const { container } = await show({ state: 'ok', document: doc() });
    expect(container.textContent).not.toMatch(/fact/i);
  });

  it('no sections: still being read, or none in use - never an empty list', async () => {
    const none = { sectionCount: 0, sections: [] };
    const { unmount } = await show({
      state: 'ok',
      document: doc({ status: 'processing' }, none),
    });
    expect(screen.getByTestId('doc-ai-none')).toHaveTextContent(
      "It's still being read. Its sections appear when it's done.",
    );
    expect(screen.getByTestId('doc-status')).toHaveTextContent(/^Being read$/);
    unmount();
    await show({ state: 'ok', document: doc({ status: 'error' }, none) });
    expect(screen.getByTestId('doc-ai-none')).toHaveTextContent('The AI uses nothing from it yet.');
    expect(screen.getByTestId('doc-status')).toHaveTextContent(/^Couldn't be read$/);
  });

  it('⚠ only an http(s) address is a link; a typed fact names its way in alone', async () => {
    const { unmount } = await show({
      state: 'ok',
      document: doc({ sourceUrl: 'javascript:alert(1)' }),
    });
    expect(screen.queryByTestId('doc-source-link')).toBeNull();
    unmount();
    await show({ state: 'ok', document: doc({ type: 'text', sourceUrl: null }) });
    expect(screen.getByTestId('doc-source')).toHaveTextContent(/^Typed by you$/);
  });

  it('no text kept: said, not an empty box', async () => {
    await show({ state: 'ok', document: doc({ content: null }) });
    expect(screen.queryByTestId('doc-content')).toBeNull();
    expect(screen.getByTestId('doc-no-content')).toHaveTextContent('No text was kept from it.');
  });
});

describe('★★ 404 and 403 are sentences, never an empty drawer', () => {
  it.each([
    ['not_found', "This item isn't in your knowledge any more."],
    ['forbidden', "You don't have permission to see what's in your knowledge."],
    ['failed', "We couldn't open this item just now. Try again in a moment."],
  ] as const)('%s', async (state, sentence) => {
    await show({ state });
    expect(screen.getByTestId('doc-problem')).toHaveTextContent(sentence);
    expect(screen.queryByTestId('doc-body')).toBeNull();
  });
});

describe('★ in Hebrew', () => {
  it('the AI heading keeps "ה‑AI" whole, and the truncation line is the agreed one', async () => {
    lang.he = true;
    try {
      await show({
        state: 'ok',
        document: doc({ content: 'x'.repeat(20000), contentLength: 45210, truncated: true }),
      });
      expect(screen.getByTestId('doc-ai')).toHaveTextContent('מה ה‑AI משתמש בו');
      expect(screen.getByTestId('doc-truncated').textContent).toMatch(
        /^מוצג חלק מהתוכן \(20,000 מתוך 45,210 תווים\)$/,
      );
    } finally {
      lang.he = false;
    }
  });
});

describe('the contract', () => {
  it('reads the route’s shape; facts and metadata are not carried', () => {
    const parsed = doc();
    expect(parsed.ai.sections).toHaveLength(2);
    expect('facts' in parsed.ai).toBe(false);
    expect('metadata' in parsed).toBe(false);
  });

  it('a field the route stops sending blanks one line, not the drawer', () => {
    const parsed = knowledgeDocumentDetailSchema.parse({ id: 'd1' });
    expect(parsed.ai).toEqual({ sectionCount: 0, sections: [], sectionsTruncated: false });
    expect(parsed.content).toBe('');
  });
});
