import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';

/** One confirmed write. Mocked: the write is a vi.fn, nothing reaches a route. */
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { ConfirmedAction } from './ConfirmedAction';

type Result = { ok: true; warnings: readonly string[] } | { ok: false; reason: string };

const run = vi.fn<(input: { readonly reason: string }) => Promise<Result>>();
const after = vi.fn();

const show = (props: Partial<Parameters<typeof ConfirmedAction<Result>>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <ConfirmedAction<Result>
        label="Do it"
        sentences={['It happens.']}
        yes="Yes, do it"
        run={run}
        done={() => 'Done.'}
        refused={(result) => `Refused: ${result.reason}`}
        testid="act"
        {...props}
      />
    </NextIntlClientProvider>,
  );
const yes = () => screen.getByTestId('act-yes');

beforeEach(() => {
  run.mockReset();
  after.mockReset();
  refresh.mockReset();
  run.mockResolvedValue({ ok: true, warnings: [] });
});

describe('★★ a confirmed write', () => {
  it('without a reason or a match, Yes is ready at once (the existing controls)', async () => {
    show();
    fireEvent.click(screen.getByTestId('act-open'));
    expect(screen.queryByTestId('act-reason')).toBeNull();
    expect(yes()).toBeEnabled();
    await act(async () => fireEvent.click(yes()));
    expect(run).toHaveBeenCalledWith({ reason: '' });
    expect(screen.getByRole('status')).toHaveTextContent('Done.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('★★ a reason is asked for, required, capped at 500, and sent trimmed', async () => {
    show({ reason: 'Reason' });
    fireEvent.click(screen.getByTestId('act-open'));
    expect(yes()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '   ' } });
    expect(yes()).toBeDisabled();
    expect(screen.getByLabelText('Reason')).toHaveAttribute('maxLength', '500');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  paid by wire ' } });
    expect(yes()).toBeEnabled();
    await act(async () => fireEvent.click(yes()));
    expect(run).toHaveBeenCalledWith({ reason: 'paid by wire' });
  });

  it('★★ a match must be typed EXACTLY: no trimming, no case folding', () => {
    show({ match: { label: 'Type the slug', value: 'acme-ltd' } });
    fireEvent.click(screen.getByTestId('act-open'));
    const field = screen.getByLabelText('Type the slug');
    for (const wrong of ['acme', 'ACME-LTD', ' acme-ltd', 'acme-ltd ']) {
      fireEvent.change(field, { target: { value: wrong } });
      expect(yes()).toBeDisabled();
    }
    fireEvent.change(field, { target: { value: 'acme-ltd' } });
    expect(yes()).toBeEnabled();
  });

  it('★ reopening starts empty: a reason is never carried to the next write', async () => {
    show({ reason: 'Reason' });
    fireEvent.click(screen.getByTestId('act-open'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'first' } });
    await act(async () => fireEvent.click(yes()));
    fireEvent.click(screen.getByTestId('act-open'));
    expect(screen.getByLabelText('Reason')).toHaveValue('');
    expect(yes()).toBeDisabled();
  });

  it('★★ a done write says its warnings under the outcome', async () => {
    run.mockResolvedValue({ ok: true, warnings: ['Still no plan.', 'A checkout is open.'] });
    show({ notes: (result) => result.warnings });
    fireEvent.click(screen.getByTestId('act-open'));
    await act(async () => fireEvent.click(yes()));
    expect(screen.getByRole('status')).toHaveTextContent('Done.');
    const notes = screen.getByTestId('act-notes');
    expect(notes.querySelectorAll('li')).toHaveLength(2);
    expect(notes).toHaveTextContent('Still no plan.');
    expect(notes).toHaveTextContent('A checkout is open.');
  });

  it('★ a refusal draws no warnings, and no list when there are none', async () => {
    run.mockResolvedValue({ ok: false, reason: 'nope' });
    show({ notes: () => ['never'] });
    fireEvent.click(screen.getByTestId('act-open'));
    await act(async () => fireEvent.click(yes()));
    expect(screen.getByRole('alert')).toHaveTextContent('Refused: nope');
    expect(screen.queryByTestId('act-notes')).toBeNull();
  });

  it('★★ `after` replaces the re-read on a done write only', async () => {
    show({ after });
    fireEvent.click(screen.getByTestId('act-open'));
    await act(async () => fireEvent.click(yes()));
    expect(after).toHaveBeenCalledWith({ ok: true, warnings: [] });
    expect(refresh).not.toHaveBeenCalled();

    run.mockResolvedValue({ ok: false, reason: 'nope' });
    fireEvent.click(screen.getByTestId('act-open'));
    await act(async () => fireEvent.click(yes()));
    expect(after).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Refused: nope');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a danger control confirms with a danger Yes', () => {
    show({ variant: 'danger' });
    fireEvent.click(screen.getByTestId('act-open'));
    expect(yes().className).toMatch(/danger/);
  });
});
