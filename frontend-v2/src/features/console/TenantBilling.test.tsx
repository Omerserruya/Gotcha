import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  planAccessSchema,
  provisionablePlansSchema,
  type ProvisioningStatus,
} from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

/** Billing oversight on a tenant's page. The writes are mocked: nothing is sent. */
const { actions, refresh } = vi.hoisted(() => ({
  actions: { repairBilling: vi.fn(), resendPaymentLink: vi.fn(), assignPaidPlan: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('./actions', () => actions);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { TenantBilling } from './TenantBilling';

const access = (state: string, over: object = {}) =>
  planAccessSchema.parse({ state, label: state, active: state.startsWith('ACTIVE'), ...over });
const request = (state: string, over: Partial<ProvisioningStatus> = {}): ProvisioningStatus => ({
  id: 'p1',
  state,
  mode: 'PAID_PLAN',
  attemptCount: 2,
  lastAttemptAt: '2026-10-20T14:05:00.000Z',
  lastFailureCode: null,
  lastFailureMessage: null,
  canRepair: state === 'PENDING' || state === 'FAILED_RETRYABLE',
  canResend: state === 'COMPLETED',
  ...over,
});

const show = (props: Partial<Parameters<typeof TenantBilling>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ console: consoleEn }}>
      <TenantBilling
        tenantId="t1"
        status="PENDING_PAYMENT"
        access={access('PENDING_PAYMENT')}
        provisioning={request('COMPLETED')}
        plans={undefined}
        {...props}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  refresh.mockClear();
});

describe('★★ resend or repair - never both', () => {
  it('★ waiting on the customer: Resend only', () => {
    show();
    expect(screen.getByTestId('resend-payment-open')).toHaveTextContent('Resend payment link');
    expect(screen.queryByTestId('repair-billing')).toBeNull();
  });

  it('★ setup never finished: Repair only, with the last failure quoted', () => {
    show({ provisioning: request('FAILED_RETRYABLE', { lastFailureMessage: 'billing timeout' }) });
    expect(screen.getByTestId('repair-billing-open')).toHaveTextContent('Repair billing setup');
    expect(screen.queryByTestId('resend-payment')).toBeNull();
    expect(screen.getByTestId('provisioning-failure')).toHaveTextContent('billing timeout');
  });

  it('★ cannot be retried: no Repair - it says what to do instead', () => {
    show({ provisioning: request('FAILED_PERMANENT', { canRepair: false }) });
    expect(screen.queryByTestId('repair-billing')).toBeNull();
    expect(screen.getByTestId('repair-impossible')).toHaveTextContent('Assign the tenant a plan');
  });

  it('★★ unread setup: neither, and it says it could not be read', () => {
    show({ provisioning: undefined });
    expect(screen.queryByTestId('resend-payment')).toBeNull();
    expect(screen.queryByTestId('repair-billing')).toBeNull();
    expect(screen.getByTestId('provisioning-state')).toHaveTextContent("Couldn't be read");
  });

  it('never requested: says so, and offers no repair', () => {
    show({ provisioning: null });
    expect(screen.getByTestId('provisioning-state')).toHaveTextContent('Never requested.');
    expect(screen.queryByTestId('repair-billing')).toBeNull();
  });

  it('the attempts, with the last one’s time in 24-hour form', () => {
    show();
    expect(screen.getByTestId('tenant-billing')).toHaveTextContent('2 attempts, the last on');
    expect(screen.getByTestId('tenant-billing')).toHaveTextContent('14:05');
  });
});

describe('★★ confirmed first, reported after, nothing optimistic', () => {
  it('★ the confirm says what will happen; Yes calls the write; the outcome is the route’s', async () => {
    let answer!: (value: unknown) => void;
    actions.resendPaymentLink.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show();
    fireEvent.click(screen.getByTestId('resend-payment-open'));
    expect(screen.getByRole('group', { name: 'Resend payment link' })).toHaveTextContent(
      'The link sent before stops working. Nothing is charged here.',
    );
    expect(actions.resendPaymentLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('resend-payment-yes'));
    expect(actions.resendPaymentLink).toHaveBeenCalledWith('t1');
    // Waiting: nothing is drawn as done.
    expect(screen.queryByTestId('resend-payment-outcome')).toBeNull();
    await act(async () => answer({ ok: true, sentTo: 'owner@acme.co' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'A new payment link was sent to owner@acme.co. The previous link no longer works.',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('★ Cancel sends nothing', () => {
    show();
    fireEvent.click(screen.getByTestId('resend-payment-open'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(actions.resendPaymentLink).not.toHaveBeenCalled();
  });

  it('★★ held: the refusal in words, as an alert', async () => {
    actions.repairBilling.mockResolvedValue({ ok: false, reason: 'held' });
    show({ provisioning: request('PENDING') });
    fireEvent.click(screen.getByTestId('repair-billing-open'));
    await act(async () => fireEvent.click(screen.getByTestId('repair-billing-yes')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Billing writes are off in this environment',
    );
  });

  it('★ repair done, and whether the customer was emailed', async () => {
    actions.repairBilling.mockResolvedValue({ ok: true, emailSent: false });
    show({ provisioning: request('PENDING') });
    fireEvent.click(screen.getByTestId('repair-billing-open'));
    await act(async () => fireEvent.click(screen.getByTestId('repair-billing-yes')));
    expect(screen.getByRole('status')).toHaveTextContent('but the email did not send');
  });

  it('rate limited: the wait the route gave', async () => {
    actions.resendPaymentLink.mockResolvedValue({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 30,
    });
    show();
    fireEvent.click(screen.getByTestId('resend-payment-open'));
    await act(async () => fireEvent.click(screen.getByTestId('resend-payment-yes')));
    expect(screen.getByRole('alert')).toHaveTextContent('Try again in 30 seconds.');
  });
});

describe('★★ a tenant with no plan to work on', () => {
  const plans = provisionablePlansSchema.parse([
    { id: 'pv1', key: 'growth', name: 'Growth' },
    { id: 'pv2', key: 'scale', name: 'Scale' },
  ]);

  it('★ says why, and assigns only once a plan is chosen', async () => {
    actions.assignPaidPlan.mockResolvedValue({ ok: true, emailSent: true });
    show({
      status: 'ACTIVE',
      access: access('MISSING', { needsReview: true }),
      provisioning: null,
      plans,
    });
    expect(screen.getByTestId('missing-plan')).toHaveTextContent('It has no plan');
    expect(screen.getByTestId('assign-plan-open')).toBeDisabled();
    fireEvent.change(screen.getByTestId('assign-plan-select'), { target: { value: 'pv2' } });
    fireEvent.click(screen.getByTestId('assign-plan-open'));
    expect(screen.getByRole('group', { name: 'Assign and request payment' })).toHaveTextContent(
      'Scale is assigned.',
    );
    await act(async () => fireEvent.click(screen.getByTestId('assign-plan-yes')));
    expect(actions.assignPaidPlan).toHaveBeenCalledWith('t1', 'pv2');
    expect(screen.getByRole('status')).toHaveTextContent('The plan was assigned.');
  });

  it('★★ two active plans: said, and nothing offered - a commercial decision', () => {
    show({ status: 'ACTIVE', access: access('CONFLICTING', { needsReview: true }), plans });
    expect(screen.getByTestId('missing-plan')).toHaveTextContent('more than one active plan');
    expect(screen.queryByTestId('assign-plan')).toBeNull();
  });

  it('plans unread, or none to offer: two sentences', () => {
    const { unmount } = show({
      status: 'ACTIVE',
      access: access('EXPIRED', { needsReview: true }),
      plans: undefined,
    });
    expect(screen.getByTestId('plans-unread')).toBeInTheDocument();
    unmount();
    show({ status: 'ACTIVE', access: access('EXPIRED', { needsReview: true }), plans: [] });
    expect(screen.getByTestId('plans-none')).toBeInTheDocument();
  });

  it('a tenant whose plan is fine: no banner', () => {
    show({ status: 'ACTIVE', access: access('ACTIVE_PAID'), provisioning: null });
    expect(screen.queryByTestId('missing-plan')).toBeNull();
  });
});
