import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { provisionablePlansSchema } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

/** Creating a tenant. Mocked: nothing is created, nothing is quoted for real. */
const { create, refresh } = vi.hoisted(() => ({
  create: { createTenant: vi.fn(), quoteProvisioning: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('./create-actions', () => create);
vi.mock('./actions', () => ({}));
vi.mock('./coupon-actions', () => ({}));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { CreateTenant, slugify } from './CreateTenant';

const plans = provisionablePlansSchema.parse([
  {
    id: 'pv1',
    key: 'growth',
    name: 'Growth',
    chatVolumeEnabled: true,
    voiceVolumeEnabled: false,
    chatOptions: [
      { key: 'chat_50', dailyVolume: 50, additionalCredits: 0, additionalPrice: '100' },
    ],
    voiceOptions: [],
  },
]);
const quote = {
  planName: 'Growth',
  basePrice: '499',
  totalAmount: '599.00',
  currency: 'ILS',
  includedCredits: 10000,
  estimatedChatsMonthly: 0,
  estimatedCallsMonthly: 0,
  billingInterval: 'MONTHLY',
  chargeableToday: false,
};

const show = (props: Partial<Parameters<typeof CreateTenant>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <CreateTenant plans={plans} domains={['ai', 'conversation']} {...props} />
    </NextIntlClientProvider>,
  );
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fillWho = () => {
  type('Organization name', 'Acme Ltd');
  type("Admin's name", 'Dana');
  type("Admin's email", 'dana@acme.co');
};

beforeEach(() => {
  create.createTenant.mockReset();
  create.quoteProvisioning.mockReset();
  create.quoteProvisioning.mockResolvedValue({ ok: true, quote });
});

describe('★★ creating a tenant', () => {
  it('slugify is the route’s rule', () => {
    expect(slugify('  Acme Ltd. (IL) ')).toBe('acme-ltd-il');
  });

  it('★ the slug follows the name until it is edited', async () => {
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    type('Organization name', 'Acme Ltd');
    expect(screen.getByLabelText('Slug')).toHaveValue('acme-ltd');
    type('Slug', 'acme');
    type('Organization name', 'Acme Group');
    expect(screen.getByLabelText('Slug')).toHaveValue('acme');
  });

  it('★★ paid: the SERVER’s quote, asked again on every change; no quote, no create', async () => {
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    fillWho();
    expect(screen.getByTestId('create-submit-open')).toBeDisabled();
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-plan'), { target: { value: 'pv1' } });
    });
    expect(create.quoteProvisioning).toHaveBeenLastCalledWith({
      planVersionId: 'pv1',
      chatVolumeOptionKey: null,
      voiceVolumeOptionKey: null,
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-chat'), { target: { value: 'chat_50' } });
    });
    expect(create.quoteProvisioning).toHaveBeenLastCalledWith({
      planVersionId: 'pv1',
      chatVolumeOptionKey: 'chat_50',
      voiceVolumeOptionKey: null,
    });
    expect(screen.getByTestId('create-quote')).toHaveTextContent('599');
    expect(screen.getByTestId('create-not-chargeable')).toBeInTheDocument();
    expect(screen.getByTestId('create-submit-open')).toBeEnabled();
  });

  it('★★ an answer counts only for the selection it was asked for - never a stale price', async () => {
    let answerChat!: (value: unknown) => void;
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    fillWho();
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-plan'), { target: { value: 'pv1' } });
    });
    expect(screen.getByTestId('create-quote')).toHaveTextContent('599');
    create.quoteProvisioning.mockReturnValueOnce(new Promise((resolve) => (answerChat = resolve)));
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-chat'), { target: { value: 'chat_50' } });
    });
    // The plan's earlier price must not stand for the new selection.
    expect(screen.queryByTestId('create-quote')).toBeNull();
    expect(screen.getByTestId('create-submit-open')).toBeDisabled();
    await act(async () => answerChat({ ok: true, quote: { ...quote, totalAmount: '699.00' } }));
    expect(screen.getByTestId('create-quote')).toHaveTextContent('699');
    expect(screen.getByTestId('create-submit-open')).toBeEnabled();
  });

  it('★ a refused quote is said, and blocks creating', async () => {
    create.quoteProvisioning.mockResolvedValue({ ok: false, reason: 'plan_gone' });
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    fillWho();
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-plan'), { target: { value: 'pv1' } });
    });
    expect(screen.getByTestId('create-quote-refused')).toHaveTextContent('no longer available');
    expect(screen.getByTestId('create-submit-open')).toBeDisabled();
  });

  it('★★ confirmed, then created: the form as the route takes it', async () => {
    create.createTenant.mockResolvedValue({ ok: true, tenantId: 't9' });
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    fillWho();
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-plan'), { target: { value: 'pv1' } });
    });
    fireEvent.click(screen.getByTestId('create-submit-open'));
    expect(screen.getByRole('group', { name: 'Create tenant' })).toHaveTextContent(
      'dana@acme.co is emailed a setup link and a payment link.',
    );
    await act(async () => fireEvent.click(screen.getByTestId('create-submit-yes')));
    expect(create.createTenant).toHaveBeenCalledWith({
      name: 'Acme Ltd',
      slug: 'acme-ltd',
      adminEmail: 'dana@acme.co',
      adminName: 'Dana',
      billing: {
        mode: 'PAID_PLAN',
        planVersionId: 'pv1',
        chatVolumeOptionKey: null,
        voiceVolumeOptionKey: null,
      },
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Acme Ltd was created and is pending payment.',
    );
  });

  it('★★ created but billing incomplete: repair, never create again', async () => {
    create.createTenant.mockResolvedValue({
      ok: false,
      reason: 'setup_incomplete',
      tenantId: 't9',
    });
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    fillWho();
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-plan'), { target: { value: 'pv1' } });
    });
    fireEvent.click(screen.getByTestId('create-submit-open'));
    await act(async () => fireEvent.click(screen.getByTestId('create-submit-yes')));
    expect(screen.getByRole('alert')).toHaveTextContent("don't create it again");
  });

  it('★★ POC: credits, a future expiry and at least one area; sent as the end of that day', async () => {
    create.createTenant.mockResolvedValue({ ok: true, tenantId: 't9' });
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    fillWho();
    fireEvent.click(screen.getByTestId('mode-POC'));
    type('Credit budget', '5000');
    type('Expires on', '2099-12-31');
    expect(screen.getByTestId('create-submit-open')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'ai' }));
    expect(screen.getByTestId('create-submit-open')).toBeEnabled();
    type('Expires on', '2001-01-01');
    expect(screen.getByTestId('create-submit-open')).toBeDisabled();
    type('Expires on', '2099-12-31');
    fireEvent.click(screen.getByTestId('create-submit-open'));
    await act(async () => fireEvent.click(screen.getByTestId('create-submit-yes')));
    expect(create.createTenant.mock.calls[0]![0].billing).toEqual({
      mode: 'POC',
      pocCredits: 5000,
      pocExpiresAt: '2099-12-31T23:59:59.000Z',
      pocFeatureAreas: ['ai'],
    });
    expect(create.quoteProvisioning).not.toHaveBeenCalled();
  });

  it('plans or areas unread: said, not an empty picker', () => {
    show({ plans: undefined, domains: undefined });
    fireEvent.click(screen.getByTestId('create-open'));
    expect(screen.getByTestId('create-plans-unread')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mode-POC'));
    expect(screen.getByTestId('create-domains-unread')).toBeInTheDocument();
  });

  it('a held paid create says so', async () => {
    create.createTenant.mockResolvedValue({ ok: false, reason: 'held' });
    show();
    fireEvent.click(screen.getByTestId('create-open'));
    fillWho();
    await act(async () => {
      fireEvent.change(screen.getByTestId('create-plan'), { target: { value: 'pv1' } });
    });
    fireEvent.click(screen.getByTestId('create-submit-open'));
    await act(async () => fireEvent.click(screen.getByTestId('create-submit-yes')));
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was created.');
  });
});
