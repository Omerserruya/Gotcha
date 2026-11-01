import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionablePlansSchema } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

/** Plan, end date, POC and credits by hand. Mocked: nothing reaches billing, nothing is charged. */
const { edit, refresh } = vi.hoisted(() => ({
  edit: { manualBillingEdit: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('./edit-actions', () => edit);
vi.mock('./create-actions', () => ({}));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { TenantPlanEdit } from './TenantPlanEdit';

const plans = provisionablePlansSchema.parse([
  {
    id: 'pv-team',
    key: 'ai_workforce',
    name: 'AI Team',
    chatVolumeEnabled: true,
    voiceVolumeEnabled: false,
    chatOptions: [{ key: 'chat_25', dailyVolume: 25 }],
    voiceOptions: [],
  },
]);

const show = (props: Partial<Parameters<typeof TenantPlanEdit>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ console: consoleEn }}>
      <TenantPlanEdit tenantId="t1" plans={plans} domains={['ai', 'conversation']} {...props} />
    </NextIntlClientProvider>,
  );
const field = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => screen.getByTestId('plan-edit-submit-open');
const confirm = async (reason = 'agreed with the customer') => {
  fireEvent.click(submit());
  field(consoleEn.edit.reason, reason);
  await act(async () => fireEvent.click(screen.getByTestId('plan-edit-submit-yes')));
};
const p = consoleEn.edit.plan;

beforeEach(() => {
  edit.manualBillingEdit.mockReset();
  edit.manualBillingEdit.mockResolvedValue({
    ok: true,
    renewal: 'off',
    after: { currentPeriodEnd: '2099-03-31T23:59:59.000Z' },
    warnings: [],
  });
  refresh.mockClear();
});

describe('★★ a tenant’s plan and credits, by hand', () => {
  it('★★ never a charge, and what is refused and why, said before anything is pressed', () => {
    show();
    expect(screen.getByTestId('plan-edit')).toHaveTextContent(p.intro);
    const upfront = screen.getByTestId('plan-edit-refused-upfront');
    expect(upfront).toBeVisible();
    expect(upfront).toHaveTextContent('a tenant Shopify bills (Shopify owns its billing)');
    expect(upfront).toHaveTextContent('a tenant in dunning (a payment is being collected)');
    expect(upfront).toHaveTextContent('an end date that has passed (it would end access at once)');
  });

  it('★ four things to change, one at a time', () => {
    show();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual([
      'Change plan',
      'Set end date',
      'Switch to POC',
      'Add credits',
    ]);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('★★ change plan, period kept: the confirm says renewal goes off and access ends with the period', async () => {
    show();
    expect(submit()).toBeDisabled();
    fireEvent.change(screen.getByTestId('plan-edit-plan'), { target: { value: 'pv-team' } });
    fireEvent.change(screen.getByTestId('plan-edit-chat'), { target: { value: 'chat_25' } });
    fireEvent.click(submit());
    const group = screen.getByRole('group');
    expect(group).toHaveTextContent('The tenant moves to AI Team, with no charge.');
    expect(group).toHaveTextContent(p.renewalOffKeep);
    field(consoleEn.edit.reason, 'upgrade agreed');
    await act(async () => fireEvent.click(screen.getByTestId('plan-edit-submit-yes')));
    expect(edit.manualBillingEdit).toHaveBeenCalledWith(
      't1',
      {
        action: 'change_plan',
        planVersionId: 'pv-team',
        chatVolumeOptionKey: 'chat_25',
        voiceVolumeOptionKey: null,
      },
      'upgrade agreed',
    );
  });

  it('★★ done: renewal off and the end date, both from what the ROUTE answered', async () => {
    show();
    fireEvent.change(screen.getByTestId('plan-edit-plan'), { target: { value: 'pv-team' } });
    await confirm();
    expect(screen.getByRole('status')).toHaveTextContent(
      'The plan was changed. Renewal is off: not charged or renewed automatically. Access ends on March 31, 2099.',
    );
  });

  it('★ an unreadable renewal is said as nothing, never guessed', async () => {
    edit.manualBillingEdit.mockResolvedValue({
      ok: true,
      renewal: null,
      after: null,
      warnings: [],
    });
    show();
    fireEvent.change(screen.getByTestId('plan-edit-plan'), { target: { value: 'pv-team' } });
    await confirm();
    expect(screen.getByRole('status')).toHaveTextContent(/^The plan was changed\.$/);
  });

  it('★★ change plan with an end date: sent as the END of that day; a past day blocks it', () => {
    show();
    fireEvent.change(screen.getByTestId('plan-edit-plan'), { target: { value: 'pv-team' } });
    field(p.endsAtOptional, '2001-01-01');
    expect(submit()).toBeDisabled();
    expect(screen.getByText(p.endsPast)).toBeInTheDocument();
    field(p.endsAtOptional, '2099-06-30');
    fireEvent.click(submit());
    expect(screen.getByRole('group')).toHaveTextContent(
      `${p.renewalOff} Access ends on June 30, 2099.`,
    );
  });

  it('★★ set end date: a future day, renewal off', async () => {
    show();
    fireEvent.click(screen.getByTestId('plan-action-set_end_date'));
    expect(submit()).toBeDisabled();
    field(p.endsAt, '2099-06-30');
    fireEvent.click(submit());
    expect(screen.getByRole('group')).toHaveTextContent(
      "The tenant's access ends on June 30, 2099, with no charge.",
    );
    field(consoleEn.edit.reason, 'r');
    await act(async () => fireEvent.click(screen.getByTestId('plan-edit-submit-yes')));
    expect(edit.manualBillingEdit.mock.calls[0]![1]).toEqual({
      action: 'set_end_date',
      endsAt: '2099-06-30T23:59:59.000Z',
    });
  });

  it('★★ switch to POC: credits, a future day and at least one area', async () => {
    show();
    fireEvent.click(screen.getByTestId('plan-action-switch_to_poc'));
    field(p.credits, '5000');
    field(p.endsAt, '2099-06-30');
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'ai' }));
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    expect(screen.getByRole('group', { name: 'Switch to POC' })).toHaveTextContent(
      'The tenant becomes a POC: 5,000 credits given, until June 30, 2099, with no charge.',
    );
    field(consoleEn.edit.reason, 'r');
    await act(async () => fireEvent.click(screen.getByTestId('plan-edit-submit-yes')));
    expect(edit.manualBillingEdit.mock.calls[0]![1]).toEqual({
      action: 'switch_to_poc',
      pocCredits: 5000,
      pocExpiresAt: '2099-06-30T23:59:59.000Z',
      pocFeatureAreas: ['ai'],
    });
  });

  it('★★ add credits: a whole number in range; renewal stays as it is', async () => {
    edit.manualBillingEdit.mockResolvedValue({
      ok: true,
      renewal: 'unchanged',
      after: null,
      warnings: [],
    });
    show();
    fireEvent.click(screen.getByTestId('plan-action-add_credits'));
    for (const bad of ['0', '-5', '2.5', '1000001', 'ten']) {
      field(p.credits, bad);
      expect(submit()).toBeDisabled();
    }
    field(p.credits, '1000000');
    expect(submit()).toBeEnabled();
    field(p.credits, '250');
    fireEvent.click(submit());
    const group = screen.getByRole('group');
    expect(group).toHaveTextContent(
      "250 credits are added to the tenant's balance, with no charge.",
    );
    expect(group).toHaveTextContent(p.renewalUnchanged);
    expect(group).not.toHaveTextContent('turned off');
    field(consoleEn.edit.reason, 'goodwill');
    await act(async () => fireEvent.click(screen.getByTestId('plan-edit-submit-yes')));
    expect(edit.manualBillingEdit).toHaveBeenCalledWith(
      't1',
      { action: 'add_credits', units: 250 },
      'goodwill',
    );
    expect(screen.getByRole('status')).toHaveTextContent(p.done.add_credits);
    expect(screen.getByRole('status')).not.toHaveTextContent('Renewal is off');
  });

  it('★ switching what to change starts its fields empty', () => {
    show();
    fireEvent.click(screen.getByTestId('plan-action-add_credits'));
    field(p.credits, '250');
    fireEvent.click(screen.getByTestId('plan-action-switch_to_poc'));
    expect(screen.getByLabelText(p.credits)).toHaveValue('');
  });

  it.each([
    ['shopify_billed', 'Shopify bills this organization.'],
    ['in_dunning', 'a payment is being collected'],
    ['end_date_in_past', 'a past date would end access at once'],
    ['billing_unreachable', "Billing didn't answer, and nothing was changed."],
  ])('★ refused %s is said in words', async (reason, text) => {
    edit.manualBillingEdit.mockResolvedValue({ ok: false, reason });
    show();
    fireEvent.click(screen.getByTestId('plan-action-add_credits'));
    field(p.credits, '10');
    await confirm();
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });

  it('plans or areas unread: said, not an empty picker', () => {
    show({ plans: undefined, domains: undefined });
    expect(screen.getByTestId('plan-edit-plans-unread')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('plan-action-switch_to_poc'));
    expect(screen.getByTestId('plan-edit-areas-unread')).toBeInTheDocument();
  });
});
