import { act, render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import employees from '@/i18n/messages/en/employees.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'employees') =>
    createTranslator({ locale: 'en', messages: { employees }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a
      href={typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`}
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock('../PauseEmployee', () => ({
  PauseEmployee: ({ paused, large }: { paused: boolean; large?: boolean }) => (
    <button type="button" data-testid="pause" data-large={large ? 'yes' : 'no'}>
      {paused ? 'Resume' : 'Pause'}
    </button>
  ),
}));

import { READINESS_POLL_MS } from '../page/EmployeeReadiness';
import type { ReadinessRun } from '../page/readiness';
import { HiredDialog } from './HiredDialog';

const REC = (type: string, title: string) => ({ type, title, detail: 'Upload the full list.' });

const show = async (over: Record<string, unknown> = {}, run?: ReadinessRun) =>
  render(
    await HiredDialog({
      run,
      employee: employeeSchema.parse({
        id: 'a',
        name: 'Maya',
        status: 'ACTIVE',
        createdAt: '2026-07-30T05:16:12.303Z',
        escalationRules: [{ label: 'Asks for a person', enabled: true }],
        ...over,
      }),
    }),
  );

describe('★★ 07e - what is true of the employee, and "-" where nothing backs 02', () => {
  it('the head: its status in words, and when it was created - never who', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Maya is working');
    expect(screen.getByTestId('hired-line')).toHaveTextContent(/^Created July 30.*05:16/);
    expect(screen.getByTestId('hired-line')).not.toHaveTextContent(/by you/);
  });

  it.each([
    ['PAUSED', 'Maya is paused', 'It does not answer while paused'],
    ['DRAFT', 'Maya is a draft', 'It does not answer yet'],
  ])('%s says so, in the head and the row', async (status, head, row) => {
    await show({ status });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(head);
    expect(screen.getByTestId('hired-answers')).toHaveTextContent(row);
  });

  it('★ no watch-only mode: the row is drawn, and says so - no "-" pill', async () => {
    await show();
    expect(screen.getByTestId('hired-watch')).toHaveTextContent('Drafts first, and tells you');
    // The reason, said as the row's line - never a bare "-" pill at its end.
    expect(screen.getByTestId('hired-watch-none')).toHaveTextContent(/no watch-only mode/);
    const lone = [...screen.getByTestId('hired-watch').querySelectorAll('*')].filter(
      (element) => element.textContent?.trim() === '-',
    );
    expect(lone).toEqual([]);
  });

  it('where it answers, and its handover rules; Change and Adjust open the employee page', async () => {
    await show();
    // Where it answers is decided in the playbook and automations, not on it.
    expect(screen.getByTestId('hired-answers')).toHaveTextContent('set in Studio · Automations');
    expect(screen.getByTestId('hired-reach')).toHaveTextContent('1 handover rule');
    expect(screen.getByTestId('hired-reach')).toHaveTextContent('Asks for a person');
    // Never the old sheet: each to its tab on the employee's page.
    expect(screen.getByTestId('hired-change')).toHaveAttribute(
      'href',
      '/studio/employees/a/channels',
    );
    expect(screen.getByTestId('hired-adjust')).toHaveAttribute('href', '/studio/employees/a');
  });

  it('★ the readiness card is the persisted report’s first recommendation, and where to fix it', async () => {
    await show({
      readinessReport: {
        generatedAt: '2026-07-31T10:00:00Z',
        recommendations: [REC('add_business_data', 'A full product catalogue'), REC('other', 'x')],
        score: 40,
      },
    });
    const card = screen.getByTestId('hired-gap');
    expect(card).toHaveTextContent('The readiness test found 2 gaps');
    expect(card).toHaveTextContent('A full product catalogue - Upload the full list.');
    expect(screen.getByTestId('hired-resolve')).toHaveAttribute('href', '/studio/knowledge');
  });

  it('a recommendation with nowhere to go has no Resolve', async () => {
    await show({ readinessReport: { recommendations: [REC('other', 'Think about it')] } });
    expect(screen.getByTestId('hired-gap')).toBeInTheDocument();
    expect(screen.queryByTestId('hired-resolve')).toBeNull();
  });

  it.each([
    [null, 'No readiness test yet'],
    [{ recommendations: [] }, 'The readiness test found no gaps'],
  ])('no finding is quiet, never amber: %j', async (readinessReport, text) => {
    await show({ readinessReport });
    expect(screen.queryByTestId('hired-gap')).toBeNull();
    expect(screen.getByTestId('hired-no-gap')).toHaveTextContent(text);
  });

  it('See it in Studio closes onto the employee; a draft cannot be paused', async () => {
    await show();
    expect(screen.getByTestId('hired-see')).toHaveAttribute('href', '/studio/employees?employee=a');
    // 02's "Pause it": the full-size button, not 07's pill.
    expect(screen.getByTestId('pause')).toHaveAttribute('data-large', 'yes');
  });

  it('a draft has no Pause', async () => {
    await show({ status: 'DRAFT' });
    expect(screen.queryByTestId('pause')).toBeNull();
  });
});

describe('★★ 07e opens as the hire completes - while its readiness test runs (H7)', () => {
  afterEach(() => {
    vi.useRealTimers();
    refresh.mockReset();
  });

  it('★ stored running: "Checking readiness…", never "No readiness test yet" - and it reads again', async () => {
    vi.useFakeTimers();
    await show({ readinessReport: null }, { state: 'running' });
    expect(screen.getByTestId('hired-checking')).toHaveTextContent('Checking readiness…');
    expect(screen.queryByTestId('hired-no-gap')).toBeNull();
    expect(screen.queryByTestId('hired-gap')).toBeNull();
    act(() => vi.advanceTimersByTime(READINESS_POLL_MS));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('done: the first recommendation, and nothing reads again', async () => {
    vi.useFakeTimers();
    await show({
      readinessReport: { recommendations: [REC('add_faq', 'Shipping')] },
    });
    expect(screen.getByTestId('hired-gap')).toHaveTextContent('Shipping');
    act(() => vi.advanceTimersByTime(READINESS_POLL_MS * 3));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('failed: why, in words - not "No readiness test yet"', async () => {
    await show({ readinessReport: null }, { state: 'failed', failure: 'llm_unavailable' });
    expect(screen.getByTestId('hired-no-gap')).toHaveTextContent(
      'The last test did not run: the AI model was not available.',
    );
  });
});
