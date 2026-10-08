import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import channels from '@/i18n/messages/en/channels.json';

/* Both change what GOTCHA tells customers, in bulk: spies, always. */
const addReadyAnswers = vi.hoisted(() => vi.fn());
const rerunAnalysis = vi.hoisted(() => vi.fn());
vi.mock('./candidate-actions', () => ({ addReadyAnswers, rerunAnalysis }));
const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

import { knowledgeDocumentOf } from '@/api/contracts/knowledge-candidates';

import { RerunFailed, ReportFoot } from './ReportFootActions';

beforeEach(() => {
  addReadyAnswers.mockReset();
  rerunAnalysis.mockReset();
  push.mockReset();
});
const intl = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ channels }}>
      {node}
    </NextIntlClientProvider>,
  );

/** `n` ready answers, each as the document adding it writes. */
const ready = (n: number, live = false) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    document: knowledgeDocumentOf(`Question ${i}?`, `Answer ${i}.`, null, live),
  }));
const foot = (n: number, live = false) =>
  intl(
    <ReportFoot
      importId="i1"
      ready={ready(n, live)}
      later={<a data-testid="later">Finish later</a>}
      noteClassName="note"
    />,
  );

describe('★★ Add the ready ones - shows every document it writes, then adds', () => {
  it('the first press lists them word for word; only the second adds, and says how many', async () => {
    addReadyAnswers.mockResolvedValue({ ok: true, approved: 2, skipped: 1 });
    foot(3, true);
    expect(screen.getByTestId('report-bulk')).toHaveTextContent('Add 3 ready answers');
    await userEvent.click(screen.getByTestId('report-bulk'));
    expect(addReadyAnswers).not.toHaveBeenCalled();
    const listed = screen.getByTestId('bulk-used');
    expect(listed.children).toHaveLength(3);
    expect(screen.getByTestId('bulk-used-c2')).toHaveTextContent('Question 2?');
    expect(screen.getByTestId('bulk-used-c2')).toHaveTextContent('Answer 2.');
    // The platform's caveat is part of what the AI reads, so it is shown.
    expect(screen.getByTestId('bulk-used-c2')).toHaveTextContent(
      'This depends on live availability.',
    );
    // While it asks, the question is the row: Finish later and Run again step aside.
    expect(screen.queryByTestId('later')).toBeNull();
    expect(screen.queryByTestId('report-rerun')).toBeNull();
    expect(screen.queryByTestId('bulk-at-most')).toBeNull();
    await userEvent.click(screen.getByTestId('bulk-yes'));
    expect(addReadyAnswers).toHaveBeenCalledWith('i1');
    expect(screen.getByTestId('bulk-done')).toHaveTextContent('2 answers added; 1 were skipped');
  });

  it('Not now adds nothing and gives the row back', async () => {
    foot(2);
    await userEvent.click(screen.getByTestId('report-bulk'));
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(addReadyAnswers).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bulk-used')).toBeNull();
    expect(screen.getByTestId('later')).toBeInTheDocument();
    expect(screen.getByTestId('report-rerun')).toBeInTheDocument();
  });

  it('past the route’s 100 a press: said, never implied to be all of them', async () => {
    foot(101);
    await userEvent.click(screen.getByTestId('report-bulk'));
    expect(screen.getByTestId('bulk-at-most')).toHaveTextContent('up to 100');
  });

  it('none ready: nothing to press', () => {
    foot(0);
    expect(screen.getByTestId('report-bulk')).toBeDisabled();
  });
});

describe('★★ Run again - says it clears the report, then starts over', () => {
  it('the warning names what goes; yes starts it and opens 13e', async () => {
    rerunAnalysis.mockResolvedValue({ ok: true });
    intl(
      <ReportFoot
        importId="i1"
        ready={ready(3)}
        later={<a data-testid="later">Finish later</a>}
        noteClassName="note"
      />,
    );
    await userEvent.click(screen.getByTestId('report-rerun'));
    expect(rerunAnalysis).not.toHaveBeenCalled();
    expect(screen.getByTestId('rerun-confirm')).toHaveTextContent('the ones you decided too');
    expect(screen.getByTestId('rerun-confirm')).toHaveTextContent(
      'Answers already in your knowledge stay.',
    );
    await userEvent.click(screen.getByTestId('rerun-yes'));
    expect(rerunAnalysis).toHaveBeenCalledWith('i1');
    expect(push).toHaveBeenCalledWith('/settings/channels?panel=whatsapp&import=i1&view=progress');
  });

  it('still running: said, nothing cleared', async () => {
    rerunAnalysis.mockResolvedValue({ ok: false, reason: 'not_settled' });
    intl(
      <ReportFoot
        importId="i1"
        ready={ready(3)}
        later={<a data-testid="later">Finish later</a>}
        noteClassName="note"
      />,
    );
    await userEvent.click(screen.getByTestId('report-rerun'));
    await userEvent.click(screen.getByTestId('rerun-yes'));
    expect(screen.getByTestId('rerun-problem')).toHaveTextContent("It's still running");
    expect(push).not.toHaveBeenCalled();
  });

  it('while it asks, the question is the row: Add and Finish later step aside, Not now brings them back', async () => {
    intl(
      <ReportFoot
        importId="i1"
        ready={ready(3)}
        later={<a data-testid="later">Finish later</a>}
        noteClassName="note"
      />,
    );
    expect(screen.getByTestId('report-bulk')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('report-rerun'));
    expect(screen.getByTestId('rerun-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('report-bulk')).toBeNull();
    expect(screen.queryByTestId('later')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByTestId('report-bulk')).toHaveTextContent('Add 3');
    expect(screen.getByTestId('later')).toBeInTheDocument();
  });
});

describe('★ Run again on a failed import - the same question, then the same route', () => {
  it('asks first; yes runs it on this import and opens its progress', async () => {
    rerunAnalysis.mockResolvedValue({ ok: true });
    intl(<RerunFailed importId="i9" />);
    await userEvent.click(screen.getByTestId('report-rerun'));
    expect(rerunAnalysis).not.toHaveBeenCalled();
    expect(screen.getByTestId('rerun-confirm')).toHaveTextContent('Run it again?');
    await userEvent.click(screen.getByTestId('rerun-yes'));
    expect(rerunAnalysis).toHaveBeenCalledWith('i9');
    expect(push).toHaveBeenCalledWith('/settings/channels?panel=whatsapp&import=i9&view=progress');
  });
});
