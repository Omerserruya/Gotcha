import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';

/** A status set by hand. Mocked: nothing is sent. */
const { edit, refresh } = vi.hoisted(() => ({
  edit: { setTenantStatus: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('./edit-actions', () => edit);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { TenantStatusEdit } from './TenantStatusEdit';

const show = (props: Partial<Parameters<typeof TenantStatusEdit>[0]> = {}, he = false) =>
  render(
    <NextIntlClientProvider
      locale={he ? 'he' : 'en'}
      messages={{ console: he ? consoleHe : consoleEn }}
    >
      <TenantStatusEdit tenantId="t1" status="PENDING_PAYMENT" planActive {...props} />
    </NextIntlClientProvider>,
  );
const choose = (value: string) =>
  fireEvent.change(screen.getByTestId('status-target'), { target: { value } });
const confirmWith = async (reason: string) => {
  fireEvent.click(screen.getByTestId('tenant-status-open'));
  fireEvent.change(screen.getByLabelText(consoleEn.edit.reason), { target: { value: reason } });
  await act(async () => fireEvent.click(screen.getByTestId('tenant-status-yes')));
};

beforeEach(() => {
  edit.setTenantStatus.mockReset();
  edit.setTenantStatus.mockResolvedValue({ ok: true, warnings: [] });
  refresh.mockClear();
});

describe('★★ a tenant’s status, set by hand', () => {
  it('★★ the four statuses the route takes, and no "trial ended" (that is the plan)', () => {
    show();
    const options = [...screen.getByTestId('status-target').querySelectorAll('option')];
    expect(options.map((option) => option.value)).toEqual([
      'ACTIVE',
      'PENDING_ONBOARDING',
      'PENDING_PAYMENT',
      'SUSPENDED',
    ]);
  });

  it('★ the current status is selected and Change waits for a different one', () => {
    show();
    expect(screen.getByTestId('status-target')).toHaveValue('PENDING_PAYMENT');
    expect(screen.getByTestId('tenant-status-open')).toBeDisabled();
    choose('ACTIVE');
    expect(screen.getByTestId('tenant-status-open')).toBeEnabled();
  });

  it('★ a status the route cannot set (admin setup) starts on "choose", never on a guess', () => {
    show({ status: 'PENDING_ADMIN_SETUP' });
    expect(screen.getByTestId('status-target')).toHaveValue('');
    expect(screen.getByTestId('tenant-status-open')).toBeDisabled();
  });

  it('★★ confirmed with a reason: the write is the chosen status and the reason', async () => {
    show();
    choose('ACTIVE');
    await confirmWith('paid by wire');
    expect(edit.setTenantStatus).toHaveBeenCalledWith('t1', 'ACTIVE', 'paid by wire');
    expect(screen.getByRole('status')).toHaveTextContent('The status is now: Active.');
    expect(refresh).toHaveBeenCalled();
  });

  it('★★ ACTIVE without an active plan says beforehand that it will not be enough', () => {
    show({ planActive: false });
    choose('ACTIVE');
    fireEvent.click(screen.getByTestId('tenant-status-open'));
    expect(screen.getByRole('group')).toHaveTextContent(consoleEn.edit.status.noPlan);
    expect(screen.getByRole('group')).toHaveTextContent('Nothing is charged.');
  });

  it('★ with a plan, or to another status, no such sentence', () => {
    show();
    choose('ACTIVE');
    fireEvent.click(screen.getByTestId('tenant-status-open'));
    expect(screen.getByRole('group')).not.toHaveTextContent(consoleEn.edit.status.noPlan);
  });

  it('★★ the route’s warnings are said, each once; an unknown code reads as one sentence', async () => {
    edit.setTenantStatus.mockResolvedValue({
      ok: true,
      warnings: ['no_access_source', 'open_checkout', 'brand_new_code', 'another_new_one'],
    });
    show();
    choose('ACTIVE');
    await confirmWith('r');
    const notes = screen.getByTestId('tenant-status-notes');
    expect([...notes.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      consoleEn.edit.warnings.no_access_source,
      consoleEn.edit.warnings.open_checkout,
      consoleEn.edit.warnings.unknown,
    ]);
  });

  it('★ a refused reason names the limit from the code', async () => {
    edit.setTenantStatus.mockResolvedValue({ ok: false, reason: 'reason_invalid' });
    show();
    choose('SUSPENDED');
    await confirmWith('r');
    expect(screen.getByRole('alert')).toHaveTextContent('Give a reason of up to 500 characters.');
  });

  it('every edit key exists in Hebrew too', () => {
    const keys = (value: unknown, at = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${at}.${key}`))
        : [at];
    expect(keys(consoleHe.edit)).toEqual(keys(consoleEn.edit));
  });
});
