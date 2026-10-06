import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { importStatusSchema } from '@/api/contracts/historical-import';
import { candidateSchema } from '@/api/contracts/knowledge-candidates';
import messages from '@/i18n/messages/en/channels.json';

/* The decisions are a client component with their own tests; here, what each card is given. */
vi.mock('./SuggestionActions', () => ({
  SuggestionActions: ({ id, variants }: { id: string; variants: readonly string[] }) => (
    <span data-testid={`decide-${id}`} data-variants={variants.join('|')} />
  ),
}));
/* The foot's two actions reach the server; they have their own tests. */
vi.mock('./ReportFootActions', () => ({
  ReportFoot: ({ count, later }: { count: number; later: ReactNode }) => (
    <>
      <span data-testid="report-bulk" data-count={count} />
      {later}
      <span data-testid="report-rerun" />
    </>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'channels.whatsapp') =>
    createTranslator({ locale: 'en', messages: { channels: messages }, namespace }),
  getLocale: async () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: { pathname: string; query?: Record<string, string> };
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a href={`${href.pathname}?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
}));

import { ImportPanel, LearningRow, ReportPanel } from './LearnPanels';

const status = (over: Record<string, unknown> = {}) =>
  importStatusSchema.parse({ id: 'i1', stage: 'analyzing', ...over });

const candidate = (over: Record<string, unknown> = {}) =>
  candidateSchema.parse({
    id: 'c1',
    question: 'Do you ship to Eilat?',
    answer: 'Yes, two to three days.',
    status: 'PENDING',
    confidence: 0.9,
    ...over,
  });

describe('★ 13b → 13e / 13f: one row while there is an import', () => {
  it('learning leads to progress; ready leads to the report', async () => {
    const { unmount } = render(await LearningRow({ status: status({ analysisPercent: 64 }) }));
    expect(screen.getByTestId('learning-row')).toHaveTextContent('Learning in progress · 64%');
    expect(screen.getByTestId('learning-row')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp&import=i1&view=progress',
    );
    unmount();
    render(await LearningRow({ status: status({ stage: 'ready', knowledgeCandidateCount: 151 }) }));
    expect(screen.getByTestId('learning-row')).toHaveTextContent('Report ready · 151 answers');
    expect(screen.getByTestId('learning-row')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp&import=i1&view=report',
    );
  });
});

describe('★ 13e - the platform’s two stages, drawn as 02’s timeline', () => {
  it('analyzing: the three kinds of learning share ONE state - they happen together', async () => {
    render(await ImportPanel({ status: status({ analysisPercent: 40 }), receiving: true }));
    for (const key of ['learning', 'answers', 'customers']) {
      expect(screen.getByTestId(`learn-step-${key}`)).toHaveAttribute('data-state', 'active');
    }
    expect(screen.getByTestId('learn-step-imported')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('import-live')).toHaveTextContent('Connected');
  });

  it('★ no ratio against a denominator of zero', async () => {
    render(
      await ImportPanel({
        status: status({ customersAnalyzed: 3, customersTotal: 0 }),
        receiving: true,
      }),
    );
    expect(screen.getByTestId('learn-step-customers')).not.toHaveTextContent(/of 0/);
  });

  it('"Connected" only when the number receives', async () => {
    render(await ImportPanel({ status: status(), receiving: false }));
    expect(screen.queryByTestId('import-live')).toBeNull();
  });

  it('failed: the reason in words, the stopped step red, run-again drawn not live', async () => {
    render(
      await ImportPanel({
        status: status({
          stage: 'failed',
          failedStage: 'analyzing',
          failureReason: 'The model timed out on 3 conversations.',
        }),
        receiving: true,
      }),
    );
    expect(screen.getByTestId('import-failed')).toHaveTextContent(
      'The model timed out on 3 conversations.',
    );
    expect(screen.getByTestId('learn-step-learning')).toHaveAttribute('data-state', 'failed');
    expect(screen.getByTestId('import-rerun')).toHaveAttribute('aria-disabled', 'true');
  });

  it('a reason that arrives as a code is made readable, never shown raw', async () => {
    render(
      await ImportPanel({
        status: status({ stage: 'failed', failureReason: 'llm_quota_exceeded' }),
        receiving: true,
      }),
    );
    expect(screen.getByTestId('import-failed')).not.toHaveTextContent('llm_quota_exceeded');
  });

  it('running: closing is safe, and the email promise rides on it, with its condition', async () => {
    render(await ImportPanel({ status: status(), receiving: true }));
    // 02's foot sentence, said - with no "minutes left": no estimate is reported.
    expect(screen.getByTestId('import-foot')).toHaveTextContent(
      "You can close this - we'll email the workspace owners when the report is ready.",
    );
    expect(screen.getByTestId('import-foot')).not.toHaveTextContent(/minutes/);
    expect(screen.getByTestId('import-close')).toHaveAttribute(
      'title',
      expect.stringMatching(/only goes to owners who have an email/),
    );
    expect(screen.getByTestId('import-review')).toHaveAttribute('aria-disabled', 'true');
  });

  it('★ 13e corrections: the active step carries its %; coexistence is said under the number', async () => {
    const one = render(
      await ImportPanel({
        status: status({ analysisPercent: 64 }),
        receiving: true,
        coexistence: true,
      }),
    );
    expect(screen.getByTestId('learn-step-learning')).toHaveTextContent('64%');
    expect(screen.getByTestId('learn-step-connected')).toHaveTextContent(
      'Coexistence · the app on your phone keeps working',
    );
    one.unmount();
    render(await ImportPanel({ status: status({ stage: 'ready' }), receiving: true }));
    expect(screen.getByTestId('learn-step-connected')).not.toHaveTextContent('Coexistence');
    expect(screen.getByTestId('learn-step-learning')).not.toHaveTextContent('%');
    expect(screen.queryByTestId('import-foot')).toBeNull();
  });

  it('ready: Review report is live', async () => {
    render(await ImportPanel({ status: status({ stage: 'ready' }), receiving: true }));
    expect(screen.getByTestId('import-review')).toHaveAttribute(
      'href',
      '/settings/channels?panel=whatsapp&import=i1&view=report',
    );
  });

  it('no history: says so instead of a timeline', async () => {
    render(await ImportPanel({ status: status({ stage: 'unavailable' }), receiving: true }));
    expect(screen.getByTestId('import-unavailable')).toHaveTextContent(/no history/i);
    expect(screen.queryByTestId('learn-timeline')).toBeNull();
  });
});

describe('★ 13f - the report, no paragraphs', () => {
  const ALL = [
    candidate({ id: 'c1', confidence: 0.92 }),
    candidate({
      id: 'c2',
      question: 'How long do I have to return an item?',
      conflict: true,
      variants: [
        { key: 'a', answer: '14 days', occurrenceCount: 40 },
        { key: 'b', answer: '30 days', occurrenceCount: 33 },
      ],
    }),
    candidate({ id: 'c3', confidence: 0.61 }),
    candidate({ id: 'c4', status: 'APPROVED' }),
    candidate({ id: 'c5', status: 'REJECTED' }),
    candidate({ id: 'c6', status: 'SUPERSEDED' }),
  ];
  const report = (tab?: string, floor: number | undefined = 0.8) =>
    ReportPanel({
      status: status({ stage: 'ready', knowledgeCandidateCount: 6 }),
      candidates: ALL,
      bulkMinConfidence: floor,
      tab,
    });

  it('02’s tabs: needs a look · ready to add · rejected - already covered only when there is any', async () => {
    render(await report());
    // c2 conflicts, c3 is under the floor; c1 is high and clean - ready to add.
    expect(screen.getByTestId('report-tab-needs_a_look')).toHaveTextContent('Needs a look2');
    expect(screen.getByTestId('report-tab-ready_to_add')).toHaveTextContent('Ready to add1');
    expect(screen.getByTestId('report-tab-rejected')).toHaveTextContent('Rejected1');
    expect(screen.getByTestId('report-tab-already_covered')).toHaveTextContent('Already covered1');
    // Approved is in use, not to review: no tab.
    expect(screen.queryByTestId('report-tab-ready')).toBeNull();
  });

  it('★ a high, clean answer is never twice: in the grey box on Needs a look, a card only on Ready to add', async () => {
    const one = render(await report());
    expect(screen.queryByTestId('candidate-c1')).toBeNull();
    expect(screen.getByTestId('report-ready-card')).toHaveTextContent('Do you ship to Eilat?');
    one.unmount();
    render(await report('ready_to_add'));
    expect(screen.getByTestId('candidate-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('report-ready-card')).toBeNull();
  });

  it('a conflict: one sentence of what was said, most-seen first; the decisions get them in that order', async () => {
    render(await report());
    const card = screen.getByTestId('candidate-c2');
    expect(screen.getByTestId('said-c2')).toHaveTextContent(
      'Your replies said 14 days in 40 chats and 30 days in 33.',
    );
    expect(within(card).getByText('Conflict')).toHaveAttribute(
      'title',
      expect.stringMatching(/will not pick for you/),
    );
    expect(within(card).getByTestId('decide-c2').getAttribute('data-variants')).toBe(
      '14 days|30 days',
    );
  });

  it('a chip only for a reason; the figure on the right - never both', async () => {
    const one = render(await report());
    const low = screen.getByTestId('candidate-c3');
    expect(low).toHaveTextContent('Low confidence');
    expect(within(low).getAllByText(/61%/)).toHaveLength(1);
    one.unmount();
    render(await report('ready_to_add'));
    const high = screen.getByTestId('candidate-c1');
    expect(within(high).getAllByText(/92%/)).toHaveLength(1);
    expect(high).not.toHaveTextContent('Low confidence');
    // The answer, quoted.
    expect(high).toHaveTextContent('“Yes, two to three days.”');
  });

  it('★ a card’s decisions are live; so are adding the ready ones and running again (Omer)', async () => {
    render(await report());
    expect(within(screen.getByTestId('candidate-c3')).getByTestId('decide-c3')).toBeInTheDocument();
    expect(screen.getByTestId('report-bulk')).toBeInTheDocument();
    expect(screen.getByTestId('report-rerun')).toBeInTheDocument();
    expect(screen.getByTestId('report-preview')).toHaveAttribute('aria-disabled', 'true');
  });

  it('★ the button counts what the tab shows - what the route takes, a live lookup included (measured on dev: 3 against 2)', async () => {
    render(
      await ReportPanel({
        status: status({ stage: 'ready' }),
        candidates: [
          candidate({ id: 'r1', confidence: 0.88, bulkApprovable: true }),
          candidate({ id: 'r3', confidence: 0.91, bulkApprovable: true }),
          candidate({ id: 'r5', confidence: 0.85, requiresLiveLookup: true, bulkApprovable: true }),
          candidate({ id: 'r6', confidence: 0.5, bulkApprovable: false }),
        ],
        bulkMinConfidence: 0.8,
        tab: 'ready_to_add',
      }),
    );
    expect(screen.getByTestId('report-tab-ready_to_add')).toHaveTextContent('Ready to add3');
    expect(screen.getByTestId('report-bulk')).toHaveAttribute('data-count', '3');
    // Still said on its card: it depends on something live.
    expect(screen.getByTestId('candidate-r5')).toHaveTextContent('Needs a live check');
  });

  it('the only sentence is the head’s; the body has no paragraph of prose', async () => {
    render(await report());
    expect(screen.getByTestId('report-panel')).not.toHaveTextContent(/evidence, not policy/);
  });
});

describe('★ 13f corrections (measurement of 9b474ed)', () => {
  it('no already-covered tab when nothing is; most-seen leads whatever order the server sends', async () => {
    render(
      await ReportPanel({
        status: status({ stage: 'ready' }),
        candidates: [
          candidate({
            id: 'k',
            conflict: true,
            variants: [
              { key: 'a', answer: '30 days', occurrenceCount: 12 },
              { key: 'b', answer: '14 days', occurrenceCount: 61 },
            ],
          }),
        ],
        bulkMinConfidence: 0.8,
        tab: undefined,
      }),
    );
    expect(screen.queryByTestId('report-tab-already_covered')).toBeNull();
    expect(screen.getByTestId('said-k')).toHaveTextContent(
      'Your replies said 14 days in 61 chats and 30 days in 12.',
    );
    expect(screen.getByTestId('decide-k').getAttribute('data-variants')).toBe('14 days|30 days');
  });

  it('no count of nothing: a candidate without chats shows only its confidence', async () => {
    render(
      await ReportPanel({
        status: status({ stage: 'ready' }),
        candidates: [candidate({ id: 'z', occurrenceCount: 0, confidence: 0.92 })],
        bulkMinConfidence: 0.8,
        tab: 'ready_to_add',
      }),
    );
    expect(within(screen.getByTestId('candidate-z')).getAllByText('92%')).toHaveLength(1);
    expect(screen.getByTestId('candidate-z')).not.toHaveTextContent(/chats?/);
  });
});
