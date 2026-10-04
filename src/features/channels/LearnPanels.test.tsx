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

describe('★ 13e — the platform’s two stages, drawn as 02’s timeline', () => {
  it('analyzing: the three kinds of learning share ONE state — they happen together', async () => {
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
    expect(screen.getByTestId('import-close')).toHaveAttribute(
      'title',
      expect.stringMatching(/Safe to close.*only goes to owners who have an email/),
    );
    expect(screen.getByTestId('import-review')).toHaveAttribute('aria-disabled', 'true');
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

describe('★ 13f — the report, no paragraphs', () => {
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

  it('tabs count each group; "already covered" never claims anything was turned down', async () => {
    render(await report());
    expect(screen.getByTestId('report-tab-needs_a_look')).toHaveTextContent('Needs a look 3');
    expect(screen.getByTestId('report-tab-ready')).toHaveTextContent('Approved 1');
    expect(screen.getByTestId('report-tab-rejected')).toHaveTextContent('Rejected 1');
    expect(screen.getByTestId('report-tab-already_covered')).toHaveTextContent('Already covered 1');
  });

  it('a conflict shows both answers and asks the reviewer to choose', async () => {
    render(await report());
    const card = screen.getByTestId('candidate-c2');
    expect(card).toHaveTextContent('Conflict');
    expect(card).toHaveTextContent('14 days');
    expect(card).toHaveTextContent('30 days');
    expect(within(card).getByText('Conflict')).toHaveAttribute(
      'title',
      expect.stringMatching(/will not pick for you/),
    );
    // Each observed answer goes to the decisions, to be used as it stands.
    expect(within(card).getByTestId('decide-c2').getAttribute('data-variants')).toMatch(
      /14 days.*\|.*30 days/,
    );
    expect(within(screen.getByTestId('candidate-c1')).getByTestId('decide-c1')).toHaveAttribute(
      'data-variants',
      '',
    );
  });

  it('below the server’s floor is "Low confidence"; above it, the percentage', async () => {
    render(await report());
    expect(screen.getByTestId('candidate-c3')).toHaveTextContent('Low confidence');
    expect(screen.getByTestId('candidate-c1')).toHaveTextContent('92%');
  });

  it('the bulk counts only what the server would take — and NOTHING with no floor', async () => {
    const { unmount } = render(await report());
    expect(screen.getByTestId('report-bulk')).toHaveTextContent('Add 1 ready answer');
    unmount();
    // Called directly: the helper's default would fill an `undefined` floor.
    render(
      await ReportPanel({
        status: status({ stage: 'ready' }),
        candidates: ALL,
        bulkMinConfidence: undefined,
        tab: undefined,
      }),
    );
    expect(screen.getByTestId('report-bulk')).toHaveTextContent('Add 0 ready answers');
  });

  it('★ a card’s decisions are live (Omer, decision 13); bulk and rerun stay drawn', async () => {
    render(await report());
    expect(within(screen.getByTestId('candidate-c1')).getByTestId('decide-c1')).toBeInTheDocument();
    expect(screen.getByTestId('report-bulk')).toHaveAttribute('aria-disabled', 'true');
  });

  it('the only sentence is the head’s; the body has no paragraph of prose', async () => {
    render(await report());
    expect(screen.getByTestId('report-panel')).not.toHaveTextContent(/evidence, not policy/);
  });
});

describe('★ 13f corrections (measurement of 9b474ed)', () => {
  it('no count of nothing: a candidate without chats shows only its confidence', async () => {
    render(
      await ReportPanel({
        status: status({ stage: 'ready' }),
        candidates: [candidate({ id: 'z', occurrenceCount: 0, confidence: 0.92 })],
        bulkMinConfidence: 0.8,
        tab: undefined,
      }),
    );
    // The chip and the meta both say 92%; neither is a count of nothing.
    expect(within(screen.getByTestId('candidate-z')).getAllByText('92%')).toHaveLength(2);
    expect(screen.getByTestId('candidate-z')).not.toHaveTextContent(/chats?/);
  });
});
