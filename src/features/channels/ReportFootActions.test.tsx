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

import { AddReady, ReportFoot } from './ReportFootActions';

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

describe('★★ Add the ready ones — asks, then adds', () => {
  it('the first press asks; the second adds and says how many', async () => {
    addReadyAnswers.mockResolvedValue({ ok: true, approved: 140, skipped: 2 });
    intl(<AddReady importId="i1" count={142} />);
    expect(screen.getByTestId('report-bulk')).toHaveTextContent('Add 142 ready answers');
    await userEvent.click(screen.getByTestId('report-bulk'));
    expect(addReadyAnswers).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('bulk-yes'));
    expect(addReadyAnswers).toHaveBeenCalledWith('i1');
    expect(screen.getByTestId('bulk-done')).toHaveTextContent('140 answers added; 2 were skipped');
  });

  it('none ready: nothing to press', () => {
    intl(<AddReady importId="i1" count={0} />);
    expect(screen.getByTestId('report-bulk')).toBeDisabled();
  });
});

describe('★★ Run again — says it clears the report, then starts over', () => {
  it('the warning names what goes; yes starts it and opens 13e', async () => {
    rerunAnalysis.mockResolvedValue({ ok: true });
    intl(
      <ReportFoot
        importId="i1"
        count={3}
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
        count={3}
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
        count={3}
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
