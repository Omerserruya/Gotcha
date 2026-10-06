import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import employees from '@/i18n/messages/en/employees.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'employees') =>
    createTranslator({ locale: 'en', messages: { employees }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
vi.mock('@/i18n/navigation', () => ({
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

import { HiredDialog } from './HiredDialog';

const REC = (type: string, title: string) => ({ type, title, detail: 'Upload the full list.' });

const show = async (over: Record<string, unknown> = {}, channels = ['WhatsApp', 'Email']) =>
  render(
    await HiredDialog({
      employee: employeeSchema.parse({
        id: 'a',
        name: 'Maya',
        status: 'ACTIVE',
        createdAt: '2026-07-30T05:16:12.303Z',
        escalationRules: [{ label: 'Asks for a person', enabled: true }],
        ...over,
      }),
      channels,
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

  it('★ no watch-only mode: the row is drawn, its value "-" with the reason', async () => {
    await show();
    expect(screen.getByTestId('hired-watch')).toHaveTextContent('Drafts first, and tells you');
    expect(screen.getByTitle(/no watch-only mode/)).toHaveTextContent('-');
  });

  it('where it answers, and its handover rules; Change and Adjust open 07f', async () => {
    await show();
    expect(screen.getByTestId('hired-answers')).toHaveTextContent('WhatsApp · Email');
    expect(screen.getByTestId('hired-reach')).toHaveTextContent('1 handover rule');
    expect(screen.getByTestId('hired-reach')).toHaveTextContent('Asks for a person');
    for (const id of ['hired-change', 'hired-adjust']) {
      expect(screen.getByTestId(id)).toHaveAttribute('href', '/studio/employees?employee=a&edit=1');
    }
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
