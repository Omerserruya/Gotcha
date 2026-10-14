import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Employee } from '@/api/contracts/employees';
import employees from '@/i18n/messages/en/employees.json';
import he from '@/i18n/messages/he/employees.json';

import { EmployeeReadiness, READINESS_POLL_MS } from './EmployeeReadiness';
import type { ReadinessRun } from './readiness';

/** H7 (Omer, 2026-10-13). The run is mocked: what it is asked, and what is said. */
const { rerunReadiness, refresh, answerReadinessQuestion } = vi.hoisted(() => ({
  rerunReadiness: vi.fn(),
  refresh: vi.fn(),
  // ⚠ A real answer writes the tenant's knowledge: only ever this mock.
  answerReadinessQuestion: vi.fn(),
}));
vi.mock('./readiness-actions', () => ({ rerunReadiness }));
vi.mock('./readiness-answer-actions', () => ({ answerReadinessQuestion }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

type Report = NonNullable<Employee['readinessReport']>;
const REPORT: Report = {
  generatedAt: '2026-10-13T10:00:00Z',
  score: 61.6,
  totals: { full: 3, partial: 1, none: 1, total: 5 },
  questions: [
    {
      id: 'q_order',
      question: 'Where is my order?',
      coverage: 'full',
      reason: '',
      answered: false,
    },
    {
      id: 'q_pay',
      question: 'Can I pay in installments?',
      coverage: 'partial',
      reason: 'Only card terms',
      answered: false,
    },
    {
      id: 'q_ship',
      question: 'Do you ship abroad?',
      coverage: 'none',
      reason: 'No shipping page',
      answered: false,
    },
  ],
  recommendations: [
    { type: 'add_faq', title: 'Add shipping abroad', detail: 'Countries and prices' },
    { type: 'connect_tool', title: 'Connect your store', detail: '' },
    { type: 'create_workflow', title: 'A refunds flow', detail: '' },
    { type: 'other', title: '  ', detail: 'no title' },
  ],
};
const IDLE: ReadinessRun = { state: 'idle' };
const show = (
  report: Employee['readinessReport'] = REPORT,
  run: ReadinessRun = IDLE,
  locale: 'en' | 'he' = 'en',
) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ employees: locale === 'he' ? he : employees }}
      timeZone="UTC"
      now={new Date('2026-10-13T12:00:00Z')}
    >
      <EmployeeReadiness employeeId="e1" report={report} run={run} />
    </NextIntlClientProvider>,
  );

/** E2: the card opens minimized; "Show all" opens the rest in place. */
const showAll = () => fireEvent.click(screen.getByTestId('readiness-toggle'));

beforeEach(() => {
  rerunReadiness.mockReset();
  rerunReadiness.mockResolvedValue({ ok: true });
  refresh.mockReset();
  answerReadinessQuestion.mockReset();
  answerReadinessQuestion.mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

describe('★★ H7 - the score, the gaps, what to add', () => {
  it('the score out of 100, how many it is fully ready for, and when', () => {
    show();
    expect(screen.getByTestId('readiness-score')).toHaveTextContent('62 out of 100');
    expect(screen.getByTestId('readiness-totals')).toHaveTextContent(
      'Fully ready for 3 of 5 questions',
    );
    expect(screen.getByTestId('readiness-score')).toHaveTextContent('Tested 2 hours ago');
  });

  it('★ the gaps: no answer first, then partial, each with the test’s reason; full is not one', () => {
    show();
    showAll();
    expect(screen.getByTestId('readiness-gap-0')).toHaveAttribute('data-coverage', 'none');
    expect(screen.getByTestId('readiness-gap-0')).toHaveTextContent('Do you ship abroad?');
    expect(screen.getByTestId('readiness-gap-0')).toHaveTextContent('No answer');
    expect(screen.getByTestId('readiness-gap-0')).toHaveTextContent('No shipping page');
    expect(screen.getByTestId('readiness-gap-1')).toHaveTextContent('Partial answer');
    expect(screen.queryByTestId('readiness-gap-2')).toBeNull();
    expect(screen.getByTestId('readiness-gaps')).not.toHaveTextContent('Where is my order?');
  });

  it('every recommendation with a title, each sent where it is resolved - or nowhere', () => {
    show();
    showAll();
    expect(screen.getByTestId('readiness-recommendation-0-go')).toHaveAttribute(
      'href',
      '/studio/knowledge',
    );
    expect(screen.getByTestId('readiness-recommendation-1-go')).toHaveAttribute(
      'href',
      '/settings/systems',
    );
    expect(screen.getByTestId('readiness-recommendation-1-go')).toHaveTextContent('Open systems');
    expect(screen.getByTestId('readiness-recommendation-2')).toHaveTextContent('A refunds flow');
    expect(screen.queryByTestId('readiness-recommendation-2-go')).toBeNull();
    expect(screen.queryByTestId('readiness-recommendation-3')).toBeNull();
  });

  it('every question covered: said, never an empty list', () => {
    show({ ...REPORT, questions: [REPORT.questions[0]!] });
    showAll();
    expect(screen.getByTestId('readiness-no-gaps')).toHaveTextContent(
      'Ready for every question in the test.',
    );
  });

  it('no score, no totals: neither is drawn as a zero', () => {
    show({ ...REPORT, score: null, totals: null });
    expect(screen.getByTestId('readiness-score')).not.toHaveTextContent('out of 100');
    expect(screen.queryByTestId('readiness-totals')).toBeNull();
  });

  it('a test that asked nothing: no "0 of 0 questions"', () => {
    show({ ...REPORT, totals: { full: 0, partial: 0, none: 0, total: 0 } });
    expect(screen.queryByTestId('readiness-totals')).toBeNull();
    expect(screen.getByTestId('readiness-score')).not.toHaveTextContent('of 0');
  });

  it('never tested: said, with a way to run it', () => {
    show(null);
    expect(screen.getByTestId('readiness-never')).toHaveTextContent('Not tested yet.');
    expect(screen.getByTestId('readiness-run')).toHaveTextContent('Run a readiness test');
  });

  it('Hebrew: "הרצה מחדש", and the totals with U+2011 before the number', () => {
    show(REPORT, IDLE, 'he');
    expect(screen.getByTestId('readiness-run')).toHaveTextContent('הרצה מחדש');
    expect(screen.getByTestId('readiness-totals')).toHaveTextContent('מוכן לגמרי ל‑3 מתוך 5 שאלות');
  });
});

describe('★★ H7 - "Checking readiness…" while it runs', () => {
  it('★ a stored running run: the line, no button, no stale report - and the page reads again', () => {
    vi.useFakeTimers();
    show(REPORT, { state: 'running' });
    expect(screen.getByTestId('readiness-checking')).toHaveTextContent('Checking readiness…');
    expect(screen.queryByTestId('readiness-run')).toBeNull();
    expect(screen.queryByTestId('readiness-gaps')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(READINESS_POLL_MS));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(READINESS_POLL_MS));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('nothing running: the page is never read again by itself', () => {
    vi.useFakeTimers();
    show();
    act(() => vi.advanceTimersByTime(READINESS_POLL_MS * 3));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('★★ Run again: the run, "Checking readiness…" while it answers, then the page read again', async () => {
    let answer: (value: unknown) => void = () => {};
    rerunReadiness.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show();
    fireEvent.click(screen.getByTestId('readiness-run'));
    expect(rerunReadiness).toHaveBeenCalledWith('e1');
    await waitFor(() => expect(screen.getByTestId('readiness-checking')).toBeInTheDocument());
    expect(screen.queryByTestId('readiness-run')).toBeNull();
    await act(async () => answer({ ok: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByTestId('readiness-problem')).toBeNull();
  });
});

describe('★★ H7 - a failed run says why, in words, with Run again', () => {
  it('each stored failure in its own words', () => {
    show(REPORT, { state: 'failed', failure: 'llm_unavailable' });
    showAll();
    expect(screen.getByTestId('readiness-failed')).toHaveTextContent(
      'The last test did not run: the AI model was not available.',
    );
    expect(screen.getByTestId('readiness-run')).toHaveTextContent('Run again');
    // The last report it has is still shown under it.
    expect(screen.getByTestId('readiness-gaps')).toBeInTheDocument();
  });

  it('Hebrew: timed_out', () => {
    show(null, { state: 'failed', failure: 'timed_out' }, 'he');
    expect(screen.getByTestId('readiness-failed')).toHaveTextContent(
      'הבדיקה האחרונה לקחה יותר מדי זמן ונעצרה.',
    );
    expect(screen.getByTestId('readiness-run')).toHaveTextContent('הרצת בדיקת מוכנות');
  });

  it('a refused run says so; a plain failure is left to the stored reason, never said twice', async () => {
    rerunReadiness.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
    const { unmount } = show();
    fireEvent.click(screen.getByTestId('readiness-run'));
    await waitFor(() =>
      expect(screen.getByTestId('readiness-problem')).toHaveTextContent(
        'Only an admin can run the test.',
      ),
    );
    expect(refresh).toHaveBeenCalled();
    unmount();

    rerunReadiness.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    show(REPORT, { state: 'failed', failure: 'internal_error' });
    fireEvent.click(screen.getByTestId('readiness-run'));
    await waitFor(() => expect(rerunReadiness).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('readiness-run')).toBeInTheDocument());
    expect(screen.queryByTestId('readiness-problem')).toBeNull();
    expect(screen.getAllByTestId('readiness-failed')).toHaveLength(1);
  });

  it('a plain failure on an older server, with no stored reason: said', async () => {
    rerunReadiness.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    show();
    fireEvent.click(screen.getByTestId('readiness-run'));
    await waitFor(() =>
      expect(screen.getByTestId('readiness-problem')).toHaveTextContent(
        'The test did not run. Try again.',
      ),
    );
  });
});

describe('★★ E2 (2026-10-14) - minimized by default, everything one press away', () => {
  it('★ one line: the score, how many are still open, when - and no gap, no recommendation drawn', () => {
    show();
    expect(screen.getByTestId('readiness-score')).toHaveTextContent('62 out of 100');
    expect(screen.getByTestId('readiness-open')).toHaveTextContent('2 questions still open');
    expect(screen.getByTestId('readiness-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('readiness-toggle')).toHaveTextContent('Show all');
    expect(screen.queryByTestId('readiness-gaps')).toBeNull();
    expect(screen.queryByTestId('readiness-recommendations')).toBeNull();
  });

  it('★ Show all opens it in place; Show less closes it', () => {
    show();
    showAll();
    expect(screen.getByTestId('readiness-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('readiness-gaps')).toBeInTheDocument();
    expect(screen.getByTestId('readiness-toggle')).toHaveTextContent('Show less');
    fireEvent.click(screen.getByTestId('readiness-toggle'));
    expect(screen.queryByTestId('readiness-gaps')).toBeNull();
  });

  it('nothing open: the line says so', () => {
    show({ ...REPORT, questions: [REPORT.questions[0]!] });
    expect(screen.getByTestId('readiness-open')).toHaveTextContent(
      'Ready for every question in the test.',
    );
  });

  it('Hebrew: הצגת הכול, and the open count', () => {
    show(REPORT, IDLE, 'he');
    expect(screen.getByTestId('readiness-toggle')).toHaveTextContent('הצגת הכול');
    expect(screen.getByTestId('readiness-open')).toHaveTextContent('2 שאלות פתוחות');
  });
});

describe('★★ E2 - a question answered here goes into the knowledge', () => {
  it('★★ Answer: the words, sent by the question’s stable id, then "added" and the page read again', async () => {
    show();
    showAll();
    fireEvent.click(screen.getByTestId('readiness-answer-start-0'));
    expect(screen.getByTestId('readiness-answer-save-0')).toBeDisabled();
    fireEvent.change(screen.getByTestId('readiness-answer-text-0'), {
      target: { value: '  Yes, to 30 countries.  ' },
    });
    fireEvent.click(screen.getByTestId('readiness-answer-save-0'));
    await waitFor(() =>
      expect(answerReadinessQuestion).toHaveBeenCalledWith(
        'e1',
        expect.objectContaining({ id: 'q_ship', question: 'Do you ship abroad?' }),
        'Yes, to 30 countries.',
      ),
    );
    expect(await screen.findByTestId('readiness-answer-added-0')).toHaveTextContent(
      'Added to knowledge.',
    );
    expect(screen.queryByTestId('readiness-answer-text-0')).toBeNull();
    expect(screen.queryByTestId('readiness-answer-start-0')).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('★ saved but not learned: said, the words kept, the question still open', async () => {
    answerReadinessQuestion.mockResolvedValue({ ok: false, reason: 'not_learned' });
    show();
    showAll();
    fireEvent.click(screen.getByTestId('readiness-answer-start-1'));
    fireEvent.change(screen.getByTestId('readiness-answer-text-1'), {
      target: { value: 'Card only.' },
    });
    fireEvent.click(screen.getByTestId('readiness-answer-save-1'));
    expect(await screen.findByTestId('readiness-answer-problem-1')).toHaveTextContent(
      'not learned yet',
    );
    expect(screen.getByTestId('readiness-answer-text-1')).toHaveValue('Card only.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Cancel: nothing sent', () => {
    show();
    showAll();
    fireEvent.click(screen.getByTestId('readiness-answer-start-0'));
    fireEvent.click(screen.getByTestId('readiness-answer-cancel-0'));
    expect(screen.queryByTestId('readiness-answer-text-0')).toBeNull();
    expect(answerReadinessQuestion).not.toHaveBeenCalled();
  });

  it('★★ a question a person answered: listed as answered, never as a gap', () => {
    show({
      ...REPORT,
      questions: [
        ...REPORT.questions,
        { id: 'q_gift', question: 'Gift cards?', coverage: 'full', reason: '', answered: true },
      ],
    });
    showAll();
    expect(screen.getByTestId('readiness-answered-0')).toHaveTextContent('Gift cards?');
    expect(screen.getByTestId('readiness-answered-0')).toHaveTextContent('Answer added');
    expect(screen.getByTestId('readiness-gaps')).not.toHaveTextContent('Gift cards?');
  });
});
