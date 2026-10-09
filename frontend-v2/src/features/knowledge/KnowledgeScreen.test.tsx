import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeSource } from '@/api/contracts/knowledge';
import messages from '@/i18n/messages/en/knowledge.json';

import { KnowledgeScreen } from './KnowledgeScreen';

/**
 * The shared-name flag, which the capture cannot reach.
 *
 * Two same-named knowledge sources exist on this machine and they are **in
 * different tenants**. `services/ai/src/routes/knowledge.ts` queries
 * `where: { tenantId }` and nothing else, so one row is the whole truth for
 * any signed-in tenant and the screen can never render both at once.
 *
 * The flag is still correct: **there is no unique index on
 * `(tenant_id, name)`**, so two same-named sources in ONE tenant are
 * possible. It is correct and currently unreachable - the same state screen
 * 04's people-collapse is in - so it is checked here rather than dropped.
 *
 * A capture test asserting something this tenant cannot produce is a test
 * that fails for being honest.
 */

/*
 * `getTranslations` is server-only and throws in this environment, so the
 * server helpers are backed by next-intl's own non-React builders - fed the
 * REAL message catalogue. The assertions below therefore check the copy a
 * reader sees, not translation keys: a test that asserted `sources.sameName`
 * would keep passing after the sentence was rewritten into something wrong.
 */
/*
 * `timeZone` matches `i18n/request.ts`, which sets `Asia/Jerusalem` for every
 * real request. A formatter without it falls back to the machine's zone (and
 * warns ENVIRONMENT_FALLBACK); one set to UTC formats a different day for any
 * timestamp in the evening. Either way the test renders a date the product
 * never shows, and a date assertion can pass while the screen is a day out.
 */
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'knowledge') =>
    createTranslator({ locale: 'en', messages: { knowledge: messages }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id: 'k1',
  name: 'Company Knowledge',
  description: null,
  isActive: true,
  scope: 'all',
  documents: [
    {
      id: 'd1',
      title: 'Wholesale terms',
      status: 'ready',
      chunkCount: 8,
      sourceType: 'pdf',
      sourceUrl: null,
      updatedAt: '2026-07-29T19:58:14.000Z',
    },
  ],
  ...over,
});

async function renderScreen(sources: readonly KnowledgeSource[]) {
  // Server component: await it, then render what it returned.
  return render(
    await KnowledgeScreen({
      sources,
      unanswered: [],
      conflicts: [],
      conflictsScannedAt: null,
      // These tests are about the sources panel; an imported workspace with
      // no conflicts keeps the conflict panel out of their way.
      everImported: true,
    }),
  );
}

describe('two sources sharing a name', () => {
  it('flags both, because the name identifies neither', async () => {
    await renderScreen([source({ id: 'k1' }), source({ id: 'k2' })]);

    const flags = screen.getAllByText(/another source has this name too/i);
    expect(flags).toHaveLength(2);
  });

  it('leaves a unique name unflagged', async () => {
    await renderScreen([source({ id: 'k1' }), source({ id: 'k2', name: 'Price list' })]);

    expect(screen.queryByText(/another source has this name too/i)).toBeNull();
    // Positive control: both sources DID render, so the absence above is the
    // flag being correctly withheld rather than nothing being drawn.
    expect(screen.getByText('Company Knowledge')).toBeInTheDocument();
    expect(screen.getByText('Price list')).toBeInTheDocument();
  });
});

describe('a date, never a verdict', () => {
  it('states when the source was last refreshed', async () => {
    await renderScreen([source()]);
    /*
     * On the element rather than by text match: the line is assembled from
     * separate JSX children, so RTL sees several text nodes and a whole-string
     * matcher finds none of them.
     *
     * And on the FACT, not the format. The ruling is that a date is stated
     * instead of a verdict; which order the month and day come in is
     * next-intl's business, and asserting it would test the library and break
     * on a locale change.
     */
    const meta = screen.getByTestId('docs-k1');
    expect(meta).toHaveTextContent(/last refreshed/i);
    expect(meta).toHaveTextContent(/2026/);
  });

  it('renders no freshness judgement of any kind', async () => {
    // There is no staleness policy in the platform - no threshold, no field,
    // no job - so "Fresh" would be a verdict needing a rule nobody wrote.
    await renderScreen([source()]);
    expect(document.body.textContent).not.toMatch(/\bfresh\b|out of date|up to date|stale/i);
  });
});
