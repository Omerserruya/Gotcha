import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { proposalBlockSchema, type ProposalBlock } from '@/api/contracts/assistant-threads';
import en from '@/i18n/messages/en/home.json';
import he from '@/i18n/messages/he/home.json';

const { approveRequest, readProposalState } = vi.hoisted(() => ({
  approveRequest: vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw new Error('a test must say what approve answers');
  }),
  readProposalState: vi.fn(async (_id: string): Promise<string | null> => null),
}));
vi.mock('../approvals/actions', () => ({ approveRequest }));
vi.mock('./proposal-state', () => ({ readProposalState }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}${href.query ? `?${new URLSearchParams(href.query)}` : ''}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));

import { ProposalCard } from './ProposalCard';

beforeEach(() => {
  approveRequest.mockClear();
  readProposalState.mockReset();
  readProposalState.mockImplementation(async () => null);
});

const PLAN = (over: Record<string, unknown> = {}): ProposalBlock =>
  proposalBlockSchema.parse({
    type: 'proposal',
    approvalRequestId: 'ap1',
    summary: 'Assign Dana to you; Create an automation',
    steps: [
      { summary: 'Assign Dana Levi’s conversation to you', target: { conversationId: 'c1' } },
      { summary: 'Create an automation', target: null },
    ],
    state: 'pending',
    ...over,
  });

const card = (proposal: ProposalBlock, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ home: locale === 'en' ? en : he }}>
      <ProposalCard proposal={proposal} />
    </NextIntlClientProvider>,
  );

describe('★ design 7 stage 3 - N changes ready, nothing is live yet', () => {
  it('★ says how many, that nothing runs yet, and each step - a target opens where it lives', () => {
    card(PLAN());
    expect(screen.getByTestId('proposal-head')).toHaveTextContent(/^2 changes ready$/);
    expect(screen.getByTestId('proposal-ap1')).toHaveTextContent('Nothing is live yet');
    expect(screen.getByTestId('proposal-ap1')).toHaveTextContent('Create an automation');
    expect(screen.getByTestId('proposal-ap1-step-0')).toHaveAttribute('href', '/inbox?c=c1');
    expect(screen.queryByTestId('proposal-ap1-step-1')).toBeNull();
    // Edit is Approvals itself, on this request.
    expect(screen.getByTestId('proposal-edit')).toHaveAttribute('href', '/approvals?id=ap1');
  });

  it('★★ approve asks first, and the question is exactly what will run', async () => {
    card(PLAN());
    await userEvent.click(screen.getByTestId('proposal-approve'));
    expect(approveRequest).not.toHaveBeenCalled();
    const confirm = screen.getByTestId('proposal-confirm');
    expect(confirm).toHaveTextContent('These 2 will run now:');
    expect(confirm).toHaveTextContent('Assign Dana Levi’s conversation to you');
    expect(confirm).toHaveTextContent('Create an automation');
    await userEvent.click(screen.getByTestId('proposal-back'));
    expect(screen.queryByTestId('proposal-confirm')).toBeNull();
    expect(approveRequest).not.toHaveBeenCalled();
  });

  it('★★ Yes is the Approvals route - the same action, this request, no edits', async () => {
    approveRequest.mockResolvedValueOnce({ ok: true, dispatched: true, dispatchError: null });
    card(PLAN());
    await userEvent.click(screen.getByTestId('proposal-approve'));
    await userEvent.click(screen.getByTestId('proposal-yes'));
    expect(approveRequest).toHaveBeenCalledTimes(1);
    expect(approveRequest).toHaveBeenCalledWith('ap1');
    expect(screen.getByTestId('proposal-head')).toHaveTextContent(/^Done$/);
    expect(screen.getByTestId('proposal-said')).toHaveTextContent('Approved, and it ran.');
    expect(screen.queryByTestId('proposal-approve')).toBeNull();
  });

  it('★ approved but not run is said - never read as done - and leads to the request', async () => {
    approveRequest.mockResolvedValueOnce({ ok: true, dispatched: false, dispatchError: 'x' });
    card(PLAN());
    await userEvent.click(screen.getByTestId('proposal-approve'));
    await userEvent.click(screen.getByTestId('proposal-yes'));
    expect(screen.getByTestId('proposal-head')).toHaveTextContent('Approved - not run yet');
    expect(screen.getByTestId('proposal-said')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('proposal-said')).toHaveTextContent(/didn’t run/);
    expect(screen.getByTestId('proposal-open')).toHaveAttribute('href', '/approvals?id=ap1');
  });

  it('a refusal is said in words, and nothing is shown as run', async () => {
    approveRequest.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
    card(PLAN());
    await userEvent.click(screen.getByTestId('proposal-approve'));
    await userEvent.click(screen.getByTestId('proposal-yes'));
    expect(screen.getByTestId('proposal-said')).toHaveTextContent(
      'You don’t have permission to decide this one.',
    );
    expect(screen.getByTestId('proposal-head')).toHaveTextContent('2 changes ready');
  });

  it('★ decided elsewhere meanwhile (409): re-read, and shown as it stands', async () => {
    approveRequest.mockResolvedValueOnce({ ok: false, reason: 'stale' });
    readProposalState.mockResolvedValueOnce('rejected');
    card(PLAN());
    await userEvent.click(screen.getByTestId('proposal-approve'));
    await userEvent.click(screen.getByTestId('proposal-yes'));
    expect(readProposalState).toHaveBeenCalledWith('ap1');
    expect(screen.getByTestId('proposal-head')).toHaveTextContent('Rejected - nothing ran');
    expect(screen.getByTestId('proposal-said')).toHaveTextContent(/Someone else decided this/);
    expect(screen.queryByTestId('proposal-approve')).toBeNull();
  });

  it('★★ decided in Approvals while this was open: a return to the tab re-reads it', async () => {
    readProposalState.mockResolvedValueOnce('executed');
    card(PLAN());
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(readProposalState).toHaveBeenCalledWith('ap1');
    expect(screen.getByTestId('proposal-head')).toHaveTextContent(/^Done$/);
    expect(screen.queryByTestId('proposal-approve')).toBeNull();
  });

  it('a settled one offers nothing, and is not re-read', async () => {
    card(PLAN({ state: 'expired' }));
    expect(screen.getByTestId('proposal-head')).toHaveTextContent('Expired - nothing ran');
    expect(screen.queryByTestId('proposal-approve')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(readProposalState).not.toHaveBeenCalled();
  });

  it('a newer read of the thread wins over what the card learned', async () => {
    readProposalState.mockResolvedValueOnce('approved');
    const view = card(PLAN());
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByTestId('proposal-head')).toHaveTextContent('Approved - not run yet');
    view.rerender(
      <NextIntlClientProvider locale="en" messages={{ home: en }}>
        <ProposalCard proposal={PLAN({ state: 'executed' })} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('proposal-head')).toHaveTextContent(/^Done$/);
  });

  it('★ in Hebrew: the supervisor’s words', async () => {
    card(PLAN(), 'he');
    expect(screen.getByTestId('proposal-head')).toHaveTextContent('2 שינויים מוכנים');
    expect(screen.getByTestId('proposal-ap1')).toHaveTextContent('עוד שום דבר לא פעיל');
    expect(screen.getByTestId('proposal-approve')).toHaveTextContent('לאשר ולהפעיל');
    expect(screen.getByTestId('proposal-edit')).toHaveTextContent('לערוך');
  });
});
