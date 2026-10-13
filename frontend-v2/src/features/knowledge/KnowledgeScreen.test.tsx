import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { knowledgeSourceSchema, type KnowledgeSource } from '@/api/contracts/knowledge';
import messages from '@/i18n/messages/en/knowledge.json';
import { expectPlainRow, expectStretchedRow } from '@/test/stretched-row';

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
/* K6: each document row's link - `href` as the address it would open. */
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children?: unknown;
    scroll?: boolean;
  }) => {
    const to =
      typeof href === 'string'
        ? href
        : `${href.pathname}?${new URLSearchParams(href.query ?? {}).toString()}`;
    return (
      <a href={to} {...rest}>
        {children as never}
      </a>
    );
  },
}));
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

describe('★ "Scan again" sits with the website (moved from Workspace, Omer 2026-10-11)', () => {
  const rescan = <button type="button" data-testid="rescan-probe" />;
  const website = source({
    id: 'web',
    name: 'Website',
    documents: [
      {
        id: 'w1',
        title: 'Home',
        status: 'ready',
        chunkCount: 3,
        sourceType: 'onboarding_scan',
        sourceUrl: 'https://urban-supply.example',
        updatedAt: '2026-07-29T19:58:14.000Z',
      },
    ],
  });
  const draw = async (sources: readonly KnowledgeSource[] | null) =>
    render(
      await KnowledgeScreen({
        sources,
        unanswered: [],
        conflicts: [],
        everImported: true,
        rescan,
      }),
    );

  it('under "Your website" when the website is listed - once', async () => {
    await draw([source(), website]);
    expect(screen.getByTestId('way-website')).toContainElement(screen.getByTestId('rescan-probe'));
    expect(screen.getAllByTestId('rescan-probe')).toHaveLength(1);
  });

  it('no website listed: first in "Where it learns from", so it can still be pressed', async () => {
    await draw([source()]);
    const probe = screen.getByTestId('rescan-probe');
    expect(screen.getByTestId('sources-section')).toContainElement(probe);
    expect(screen.queryByTestId('way-website')).toBeNull();
  });

  it('the sources read failed: still there, beside the sentence saying so', async () => {
    await draw(null);
    expect(screen.getByTestId('sources-section')).toContainElement(
      screen.getByTestId('rescan-probe'),
    );
    expect(screen.getByTestId('sources-unavailable')).toBeInTheDocument();
  });

  it('none handed in (the workspace read failed): nothing drawn', async () => {
    render(
      await KnowledgeScreen({
        sources: [website],
        unanswered: [],
        conflicts: [],
        everImported: true,
      }),
    );
    expect(screen.queryByTestId('knowledge-rescan')).toBeNull();
  });
});

/*
 * K5 (Omer, 2026-10-11): what was just added is in the list at once - a row
 * of its own, with its state. Before, a source row stood for everything in
 * it, so an added document turned "One document" into "2 documents" and
 * nothing appeared.
 */
describe('★★ K5 - every document is a row, and a just-added one says it is being read', () => {
  const doc = (over: Partial<KnowledgeSource['documents'][number]>) => ({
    id: 'd-new',
    title: 'Autumn terms',
    status: 'pending',
    chunkCount: 0,
    sourceType: 'file',
    sourceUrl: null,
    updatedAt: '2026-10-11T09:00:00.000Z',
    ...over,
  });

  it('★★ the just-added document is listed, still being read - beside the older one', async () => {
    const older = source().documents[0]!;
    await renderScreen([source({ documents: [doc({}), older] })]);
    const row = screen.getByTestId('doc-d-new');
    expect(row).toHaveTextContent('Autumn terms');
    expect(row).toHaveAttribute('data-state', 'reading');
    expect(screen.getByTestId('doc-state-d-new')).toHaveTextContent(/^Being read$/);
    expect(row).toHaveTextContent('updated October 11, 2026');
    // The older, ready one is a row too, and claims no state.
    expect(screen.getByTestId('doc-d1')).toHaveTextContent('Wholesale terms');
    expect(screen.queryByTestId('doc-state-d1')).toBeNull();
    // Newest first, as the route orders them - under their source.
    const rows = screen
      .getAllByTestId(/^(source|doc)-/)
      .filter((el) => el.tagName === 'LI' || el.dataset.testid!.startsWith('source-'))
      .map((el) => el.dataset.testid);
    expect(rows).toEqual(['source-k1', 'doc-d-new', 'doc-d1']);
  });

  it('`processing` is being read too; `error` says it could not be read', async () => {
    await renderScreen([
      source({
        documents: [doc({ id: 'p', status: 'processing' }), doc({ id: 'e', status: 'error' })],
      }),
    ]);
    expect(screen.getByTestId('doc-state-p')).toHaveTextContent(/^Being read$/);
    expect(screen.getByTestId('doc-e')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId('doc-state-e')).toHaveTextContent(/^Couldn't be read$/);
  });

  it('a status nobody wrote down is not "ready"', async () => {
    await renderScreen([source({ documents: [doc({ id: 'x', status: 'queued' })] })]);
    expect(screen.getByTestId('doc-x')).toHaveAttribute('data-state', 'reading');
  });

  it('an untitled document says so, and the title is set apart as the user’s text', async () => {
    await renderScreen([
      source({ documents: [doc({ id: 'u', title: '' }), doc({ id: 'h', title: 'תנאי משלוח' })] }),
    ]);
    expect(screen.getByTestId('doc-u')).toHaveTextContent('Untitled');
    expect(screen.getByTestId('doc-u').querySelector('bdi')).toBeNull();
    const bdi = screen.getByTestId('doc-h').querySelector('bdi');
    expect(bdi).toHaveTextContent('תנאי משלוח');
    expect(bdi).toHaveAttribute('dir', 'auto');
  });
});

/*
 * K6 (Omer, 2026-10-11): a document row opens its drawer - the whole row,
 * through its one link (row-link), one tab stop. The source row above it is
 * left as it was.
 */
describe('★★ K6 - a document row opens its drawer', () => {
  it('the whole row, through one link to ?doc=<id>', async () => {
    await renderScreen([source()]);
    const link = expectStretchedRow(screen.getByTestId('doc-d1'));
    expect(link).toHaveAttribute('href', '/studio/knowledge?doc=d1');
    expect(link).toHaveTextContent('Wholesale terms');
  });

  it('a row still being read opens too - its state is not a second stop', async () => {
    await renderScreen([
      source({
        documents: [
          {
            id: 'p',
            title: 'Autumn terms',
            status: 'pending',
            chunkCount: 0,
            sourceType: 'file',
            sourceUrl: null,
            updatedAt: null,
          },
        ],
      }),
    ]);
    expect(expectStretchedRow(screen.getByTestId('doc-p'))).toHaveAttribute(
      'href',
      '/studio/knowledge?doc=p',
    );
  });

  it('the source row is not a link', async () => {
    await renderScreen([source()]);
    expectPlainRow(screen.getByTestId('source-k1'));
  });
});

/*
 * K10 (Omer, 2026-10-12): the list's items are numbered 1, 2, 3… - drawn, in
 * an ordered list - each titled by its kind's icon and its name, with the
 * stored summary under it, or no line at all.
 */
describe('★★ K10 - numbered items, each a title over what it contains', () => {
  const doc = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Title ${id}`,
    status: 'ready',
    sourceType: 'file',
    ...over,
  });
  const parsed = (id: string, documents: Record<string, unknown>[]) =>
    knowledgeSourceSchema.parse({ id, name: id, documents });

  it('★★ 1, 2, 3… down the whole list - across groups and sources, never again from 1', async () => {
    await renderScreen([
      parsed('uploads', [doc('u1'), doc('u2')]),
      parsed('site', [doc('w1', { sourceType: 'url' }), doc('w2', { sourceType: 'url' })]),
      parsed('more', [doc('u3')]),
    ]);
    // Drawn, in the order a reader meets them: the website group first.
    const numbers = screen.getAllByTestId(/^doc-number-/);
    expect(numbers.map((n) => n.dataset.testid)).toEqual([
      'doc-number-w1',
      'doc-number-w2',
      'doc-number-u1',
      'doc-number-u2',
      'doc-number-u3',
    ]);
    expect(numbers.map((n) => n.textContent)).toEqual(['1', '2', '3', '4', '5']);
    // An ordered list each, starting where the last one stopped.
    const lists = [...document.querySelectorAll('ol')];
    expect(lists.map((ol) => ol.getAttribute('start'))).toEqual(['1', '3', '5']);
    for (const id of ['w1', 'u1', 'u3']) {
      expect(screen.getByTestId(`doc-${id}`).parentElement?.tagName).toBe('OL');
    }
  });

  it('the title is the name, the row’s one link, and the number is outside it', async () => {
    await renderScreen([parsed('k', [doc('a', { title: 'Shipping terms' })])]);
    const link = screen.getByTestId('doc-open-a');
    expect(link).toHaveTextContent(/^Shipping terms$/);
    expect(link).not.toContainElement(screen.getByTestId('doc-number-a'));
  });

  it('★★ a stored summary is the line under the title, as the user’s text', async () => {
    await renderScreen([parsed('k', [doc('a', { summary: '  משלוחים והחזרות, תוך 14 יום  ' })])]);
    const line = screen.getByTestId('doc-summary-a');
    expect(line).toHaveTextContent(/^משלוחים והחזרות, תוך 14 יום$/);
    expect(line.querySelector('bdi')).toHaveAttribute('dir', 'auto');
    expect(screen.getByTestId('doc-a')).toContainElement(line);
  });

  it('★★ markdown in a summary reads as plain text (dev, 2026-10-13)', async () => {
    await renderScreen([
      parsed('k', [
        doc('md', { summary: '**אפשר להחליף מידה?** כן בטח\n- תוך 14 יום' }),
        doc('marks', { summary: '** **' }),
      ]),
    ]);
    expect(screen.getByTestId('doc-summary-md')).toHaveTextContent(
      /^אפשר להחליף מידה\? כן בטח · תוך 14 יום$/,
    );
    // Only markers: nothing left to say, so no line.
    expect(screen.queryByTestId('doc-summary-marks')).toBeNull();
  });

  it('★★ absent, null, empty or only spaces: no line at all - and nothing put in its place', async () => {
    await renderScreen([
      parsed('k', [
        doc('absent'),
        doc('null', { summary: null }),
        doc('empty', { summary: '' }),
        doc('spaces', { summary: ' \n\t ' }),
        doc('given', { summary: 'Prices and terms for shops' }),
      ]),
    ]);
    for (const id of ['absent', 'null', 'empty', 'spaces']) {
      expect(screen.queryByTestId(`doc-summary-${id}`), id).toBeNull();
      // The row says its number and its name - nothing derived stands in.
      expect(screen.getByTestId(`doc-${id}`).textContent, id).toBe(
        `${screen.getByTestId(`doc-number-${id}`).textContent}Title ${id}`,
      );
    }
    // Positive control: the same render does draw a summary that is there.
    expect(screen.getByTestId('doc-summary-given')).toHaveTextContent('Prices and terms for shops');
  });
});

describe('★ "scanned automatically" - only where every document came from the scan', () => {
  const ofTypes = (id: string, types: string[]) =>
    source({
      id,
      name: id,
      documents: types.map((sourceType, i) => ({
        ...source().documents[0]!,
        id: `${id}-${i}`,
        sourceType,
      })),
    });

  it('the scan’s summary and its crawled pages (`url_text`): scanned', async () => {
    await renderScreen([ofTypes('site', ['onboarding_scan', 'url_text'])]);
    expect(screen.getByTestId('way-website')).toHaveTextContent('scanned automatically');
  });

  it('a page added by hand among them: not said', async () => {
    await renderScreen([ofTypes('site', ['url_text', 'url'])]);
    expect(screen.getByTestId('way-website')).not.toHaveTextContent('scanned automatically');
  });
});
