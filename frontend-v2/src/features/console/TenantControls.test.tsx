import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';

/** The tenant's own controls. Mocked: nothing is sent. */
const { actions, refresh } = vi.hoisted(() => ({
  actions: {
    renameTenant: vi.fn(),
    setTenantActive: vi.fn(),
    resendOnboarding: vi.fn(),
    repairBilling: vi.fn(),
    resendPaymentLink: vi.fn(),
    assignPaidPlan: vi.fn(),
  },
  refresh: vi.fn(),
}));
vi.mock('./actions', () => actions);
vi.mock('./coupon-actions', () => ({}));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { TenantControls } from './TenantControls';

const show = (props: Partial<Parameters<typeof TenantControls>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <TenantControls tenantId="t1" name="Acme" status="ACTIVE" isActive {...props} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  refresh.mockClear();
});

describe('★★ the tenant’s controls', () => {
  it('★ an enabled tenant offers Disable, confirmed, and says it is done', async () => {
    actions.setTenantActive.mockResolvedValue({ ok: true });
    show();
    fireEvent.click(screen.getByTestId('tenant-active-open'));
    expect(screen.getByRole('group', { name: 'Disable tenant' })).toHaveTextContent(
      'Nobody in this tenant can sign in',
    );
    await act(async () => fireEvent.click(screen.getByTestId('tenant-active-yes')));
    expect(actions.setTenantActive).toHaveBeenCalledWith('t1', false);
    expect(screen.getByRole('status')).toHaveTextContent('The tenant is disabled.');
  });

  it('a disabled one offers Enable', () => {
    show({ isActive: false });
    expect(screen.getByTestId('tenant-active-open')).toHaveTextContent('Enable tenant');
  });

  it('★★ resend onboarding: not for ACTIVE, not for PENDING_PAYMENT - only before onboarding ends', () => {
    const { unmount } = show({ status: 'ACTIVE' });
    expect(screen.queryByTestId('resend-onboarding')).toBeNull();
    unmount();
    const second = show({ status: 'PENDING_PAYMENT' });
    expect(screen.queryByTestId('resend-onboarding')).toBeNull();
    second.unmount();
    show({ status: 'PENDING_ADMIN_SETUP' });
    expect(screen.getByTestId('resend-onboarding-open')).toBeInTheDocument();
  });

  it('★ resend onboarding says who it went to', async () => {
    actions.resendOnboarding.mockResolvedValue({ ok: true, sentTo: 'admin@acme.co' });
    show({ status: 'PENDING_ONBOARDING' });
    fireEvent.click(screen.getByTestId('resend-onboarding-open'));
    await act(async () => fireEvent.click(screen.getByTestId('resend-onboarding-yes')));
    expect(screen.getByRole('status')).toHaveTextContent(
      'The onboarding email was sent to admin@acme.co.',
    );
  });

  it('★ rename: Save only when the name changed, then the route’s answer', async () => {
    actions.renameTenant.mockResolvedValue({ ok: false, reason: 'forbidden' });
    show();
    expect(screen.getByTestId('rename-save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(screen.getByTestId('rename-save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme Ltd' } });
    await act(async () => fireEvent.click(screen.getByTestId('rename-save')));
    expect(actions.renameTenant).toHaveBeenCalledWith('t1', 'Acme Ltd');
    expect(screen.getByTestId('rename-outcome')).toHaveTextContent(
      'The platform refused: this needs a platform administrator.',
    );
    expect(refresh).toHaveBeenCalled();
  });
});
