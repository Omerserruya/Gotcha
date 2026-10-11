import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { autoPurchaseSchema } from '@/api/contracts/auto-purchase';
import { pricePer, subscriptionSchema } from '@/api/contracts/billing';
import { billingProfileSchema, paymentMethodSchema } from '@/api/contracts/billing-profile';
import { creditSummarySchema } from '@/api/contracts/credits';
import { invoiceSchema } from '@/api/contracts/invoices';
import messages from '@/i18n/messages/en/billing.json';
import { expectPlainRow, expectStretchedRow } from '@/test/stretched-row';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing.overview') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
  getLocale: async () => 'en',
}));
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

import * as Overview from './Overview';
import { BillingCard, PlanHero, RunningLow } from './Overview';

/** The measured ACTIVE row: MONTHLY, over a period a year long. */
const MEASURED = {
  planKey: 'ai_voice',
  status: 'ACTIVE',
  snapshotPrice: '1499.00',
  snapshotCurrency: 'USD',
  billingInterval: 'MONTHLY',
  currentPeriodStart: '2026-09-08T14:19:24.353Z',
  currentPeriodEnd: '2027-09-08T14:19:24.353Z',
  createdAt: '2026-07-28T16:06:14.454Z',
};
const sub = (over: Record<string, unknown> = {}) =>
  subscriptionSchema.parse({ ...MEASURED, ...over });

describe('★ 17 - "a month" only when the period agrees', () => {
  it('MONTHLY over a year says nothing; over a month, "a month"', () => {
    expect(pricePer(sub())).toBeNull();
    expect(
      pricePer(
        sub({
          currentPeriodStart: '2026-09-08T00:00:00Z',
          currentPeriodEnd: '2026-10-08T00:00:00Z',
        }),
      ),
    ).toBe('month');
  });

  it('the hero writes the bare price for the measured row', async () => {
    render(
      await PlanHero({
        subscription: sub(),
        plans: [{ key: 'ai_voice', name: 'AI Voice' }],
        credits: creditSummarySchema.parse({ plan: { includedCredits: 7000 } }),
      }),
    );
    expect(screen.getByTestId('plan-name')).toHaveTextContent('AI Voice');
    expect(screen.getByTestId('plan-price')).toHaveTextContent(/^\$1,499$/);
    expect(screen.getByTestId('plan-since')).toHaveTextContent('since July 2026');
    expect(screen.getByTestId('plan-hero')).toHaveTextContent('7,000 credits included');
    expect(screen.getByTestId('plan-buy')).toHaveAttribute('href', '/settings/billing?panel=buy');
    expect(screen.getByTestId('plan-change')).toHaveAttribute('href', '/settings/billing/plan');
  });
});

describe('★ 17 - no "Where credits went" (Omer, 2026-10-11)', () => {
  it('the section is not a component any more, and its copy is gone in both languages', async () => {
    expect(Overview).not.toHaveProperty('CreditsWent');
    const he = (await import('@/i18n/messages/he/billing.json')).default;
    expect(messages.overview).not.toHaveProperty('went');
    expect(he.overview).not.toHaveProperty('went');
    expect(JSON.stringify(messages)).not.toMatch(/where credits went/i);
    expect(JSON.stringify(he)).not.toMatch(/לאן הלכו הקרדיטים/);
  });
});

describe('★ 17 - when credits run low', () => {
  it('unset says what happens; a cap is its ceiling; pay-as-you-go is warned in red', async () => {
    const { unmount } = render(await RunningLow({ policy: null, currency: 'USD' }));
    expect(screen.getByTestId('running-low-rule')).toHaveTextContent(/AI stops answering/);
    expect(screen.getByTestId('running-low-change')).toHaveAttribute(
      'href',
      '/settings/billing?panel=low',
    );
    unmount();

    render(
      await RunningLow({
        policy: autoPurchaseSchema.parse({
          enabled: true,
          thresholdPct: 10,
          maxMonthlySpend: '500.00',
          limitBehavior: 'PAYG',
        }),
        currency: 'USD',
      }),
    );
    expect(screen.getByTestId('running-low-cap')).toHaveTextContent(
      'Most you could spend this month: $500',
    );
    expect(screen.getByTestId('running-low-not-a-cap')).toBeInTheDocument();
  });
});

describe('★ 17 - the Billing card', () => {
  const failed = (id: string) =>
    invoiceSchema.parse({
      id,
      status: 'FAILED',
      amount: '1499.00',
      currency: 'USD',
      issuedAt: '2026-09-07T00:00:00Z',
    });

  it('★ paid is the amount alone; anything else carries its state', async () => {
    render(
      await BillingCard({
        profile: billingProfileSchema.parse({ state: 'present' }),
        methods: [],
        invoices: [
          invoiceSchema.parse({ ...failed('p'), status: 'PAID' }),
          failed('f'),
          invoiceSchema.parse({ ...failed('i'), status: 'ISSUED' }),
        ],
      }),
    );
    expect(screen.getByTestId('billing-invoice-p')).toHaveTextContent(/^Sep \$1,499$/);
    expect(
      screen.getByTestId('billing-invoice-f').querySelector('[data-status="FAILED"]'),
    ).not.toBeNull();
    expect(screen.getByTestId('billing-invoice-i')).toHaveTextContent('Issued');
  });

  it('the measured tenant: no card and four failed charges, said once, in red', async () => {
    render(
      await BillingCard({
        profile: billingProfileSchema.parse({ state: 'present' }),
        methods: [],
        invoices: ['a', 'b', 'c', 'd'].map(failed),
      }),
    );
    expect(within(screen.getByTestId('billing-row-card')).getByText('None on file')).toBeTruthy();
    expect(screen.getByTestId('billing-alert')).toHaveTextContent(
      'No payment method on file, and 4 charges have already failed.',
    );
    // A failed renewal says it failed - never a bare amount that reads as paid.
    expect(screen.getByTestId('billing-row-invoices')).toHaveTextContent(
      "Sep $1,499 Didn't go through · Sep $1,499 Didn't go through · Sep $1,499 Didn't go through",
    );
    expect(screen.getByTestId('billing-invoices-all')).toHaveAttribute(
      'href',
      '/settings/billing/invoices',
    );
  });

  it('an unread payment method is "-", never "None on file"', async () => {
    render(await BillingCard({ profile: null, methods: null, invoices: null }));
    const card = within(screen.getByTestId('billing-row-card')).getByText('-');
    expect(card).toHaveAttribute('title', expect.stringMatching(/couldn't check/));
    expect(screen.queryByTestId('billing-alert')).toBeNull();
  });

  it('a filled profile is who is invoiced and where receipts go', async () => {
    render(
      await BillingCard({
        profile: billingProfileSchema.parse({
          billingName: 'Aviv & Co. Ltd',
          vatId: '515234781',
          billingEmail: 'finance@example.com',
        }),
        methods: [paymentMethodSchema.parse({ id: 'pm', brand: 'Visa', last4: '4417' })],
        invoices: [],
      }),
    );
    expect(screen.getByTestId('billing-row-card')).toHaveTextContent('Visa · 4417');
    expect(screen.getByTestId('billing-row-invoiced')).toHaveTextContent(
      'Aviv & Co. Ltd · 515234781',
    );
    expect(screen.getByTestId('billing-row-receipts')).toHaveTextContent('finance@example.com');
    expect(screen.getByTestId('billing-row-invoices')).toHaveTextContent('None yet');
  });
});

describe('★ 17 - a change already applied is not announced (ported from PlanLine)', () => {
  const SCHEDULED = {
    changeType: 'DOWNGRADE',
    targetPlanKey: 'foundation',
    effectiveAt: '2027-09-08T14:19:24.353Z',
    appliedAt: null,
  };
  const hero = async (pendingChange: unknown) =>
    render(
      await PlanHero({
        subscription: sub({ pendingChange }),
        plans: [
          { key: 'ai_voice', name: 'AI Voice' },
          { key: 'foundation', name: 'Foundation' },
        ],
        credits: null,
      }),
    );

  it('announces one still coming, by the plan’s name', async () => {
    await hero(SCHEDULED);
    expect(screen.getByTestId('plan-pending')).toHaveTextContent(
      'Changes to Foundation at renewal',
    );
  });

  it('says NOTHING once the scheduler has applied it', async () => {
    await hero({ ...SCHEDULED, appliedAt: '2026-09-08T00:00:00Z' });
    expect(screen.queryByTestId('plan-pending')).toBeNull();
  });
});

describe('★★ the Billing card’s Invoices row opens the list from anywhere on it (Omer, 2026-10-11)', () => {
  const paid = (id: string) =>
    invoiceSchema.parse({ id, status: 'PAID', amount: '10.00', currency: 'USD' });

  it('with invoices: "All", stretched, the row’s only stop; the other rows have nothing to open', async () => {
    render(
      await BillingCard({
        profile: billingProfileSchema.parse({ state: 'present' }),
        methods: [],
        invoices: [paid('p')],
      }),
    );
    expect(expectStretchedRow(screen.getByTestId('billing-row-invoices'))).toBe(
      screen.getByTestId('billing-invoices-all'),
    );
    expectPlainRow(screen.getByTestId('billing-row-card'));
  });

  it('no invoices: no "All", so nothing stretched', async () => {
    render(
      await BillingCard({
        profile: billingProfileSchema.parse({ state: 'present' }),
        methods: [],
        invoices: [],
      }),
    );
    expectPlainRow(screen.getByTestId('billing-row-invoices'));
  });
});
