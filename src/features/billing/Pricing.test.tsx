import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { Plan, Subscription } from '@/api/contracts/billing';
import { currencyBlockSchema, packagesResponseSchema } from '@/api/contracts/pricing';
import messages from '@/i18n/messages/en/billing.json';

import { CreditPackagesSection, CurrentPlanSection } from './Pricing';

/**
 * Screen 17b, tested where a capture cannot reach.
 *
 * This tenant has **no scheduled change**, an **eligible** plan and **four**
 * packages, so three of the branches that matter most — a scheduled CANCEL, a
 * plan that cannot buy credits, a fallback exchange rate — are unreachable by
 * evidence. They are asserted here instead of being left to a screenshot that
 * would have proved the one state the tenant happens to be in.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing.pricing') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
  getLocale: async () => 'en',
}));

const PLANS: readonly Plan[] = [
  { key: 'ai_voice', name: 'AI Voice', nameHe: null },
  { key: 'foundation', name: 'Foundation', nameHe: null },
];

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  planKey: 'ai_voice',
  status: 'ACTIVE',
  snapshotPrice: '1499.00',
  snapshotCurrency: 'USD',
  currentPeriodEnd: '2027-09-08T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  billingInterval: 'YEAR',
  pendingChange: null,
  ...over,
});

const pending = (over: Record<string, unknown> = {}) => ({
  changeType: 'DOWNGRADE' as const,
  targetPlanKey: 'foundation',
  effectiveAt: '2027-09-08T00:00:00.000Z',
  appliedAt: null,
  ...over,
});

async function renderPlan(over: Partial<Subscription> = {}, extra: Record<string, unknown> = {}) {
  render(
    await CurrentPlanSection({
      subscription: subscription(over),
      plans: PLANS,
      currency: null,
      tax: null,
      disclaimer: null,
      ...extra,
    } as Parameters<typeof CurrentPlanSection>[0]),
  );
}

describe('a scheduled change says which kind it is', () => {
  it('names the plan and the date for a downgrade', async () => {
    await renderPlan({ pendingChange: pending() });
    const line = screen.getByTestId('pricing-pending-line');
    expect(line).toHaveTextContent('Foundation');
    // The YEAR, asserted as PRESENT rather than in a format.
    expect(line).toHaveTextContent(/2027/);
  });

  it('says the subscription ENDS for a cancellation', async () => {
    /*
     * A CANCEL carries no targetPlanKey. Rendered as a plan change it would
     * read "Changes to — on 8 September 2027" for a customer who is leaving.
     */
    await renderPlan({ pendingChange: pending({ changeType: 'CANCEL', targetPlanKey: null }) });
    const line = screen.getByTestId('pricing-pending-line');
    expect(line).toHaveTextContent(/ends/i);
    expect(line).not.toHaveTextContent(/changes to/i);
    expect(line).not.toHaveTextContent('—');
  });

  it('promises that nothing moves until then', async () => {
    // The service's own guarantee, and the thing a person wants before
    // clicking: "the current plan, its features, its limits and its credits
    // all stay exactly as they are until then."
    await renderPlan({ pendingChange: pending() });
    expect(screen.getByTestId('pricing-pending-holds')).toHaveTextContent(
      /stay exactly as they are/i,
    );
  });

  it('shows nothing at all once the scheduler has applied it', async () => {
    await renderPlan({ pendingChange: pending({ appliedAt: '2027-09-08T02:00:00.000Z' }) });
    expect(screen.queryByTestId('pricing-pending')).toBeNull();
  });
});

describe('the price shown is not always the price charged', () => {
  it('says which currency the charge is in', async () => {
    await renderPlan(
      {},
      {
        currency: currencyBlockSchema.parse({
          display: 'ILS',
          chargedCurrency: 'USD',
          isEstimatedConversion: true,
          fx: { rate: 3.72, isFallback: false },
        }),
      },
    );
    expect(screen.getByTestId('pricing-currency')).toHaveTextContent(/charged in USD/i);
  });

  it('names the charged amount as the checkable one on a fallback rate', async () => {
    // A fallback rate is not a rate, and the only number a customer can check
    // against their statement is the charged one.
    await renderPlan(
      {},
      {
        currency: currencyBlockSchema.parse({
          display: 'ILS',
          chargedCurrency: 'USD',
          isEstimatedConversion: true,
          fx: { rate: 3.6, isFallback: true },
        }),
      },
    );
    expect(screen.getByTestId('pricing-currency')).toHaveTextContent(/fallback rate/i);
    expect(screen.getByTestId('pricing-currency')).toHaveTextContent(/match your statement/i);
  });

  it('says nothing when the displayed currency is the charged one', async () => {
    await renderPlan(
      {},
      { currency: currencyBlockSchema.parse({ display: 'USD', chargedCurrency: 'USD' }) },
    );
    expect(screen.queryByTestId('pricing-currency')).toBeNull();
  });

  it('states that the price excludes tax', async () => {
    await renderPlan({}, { tax: { ratePct: 18, label: 'VAT' } });
    expect(screen.getByTestId('pricing-net')).toHaveTextContent(/before VAT \(18%\)/);
  });
});

describe('the disclaimer is the platform’s, not ours', () => {
  it('renders the string the route shipped', async () => {
    const shipped = 'Conversation estimates are based on the plan configuration.';
    await renderPlan({}, { disclaimer: { en: shipped, he: 'עברית' } });
    expect(screen.getByTestId('pricing-disclaimer')).toHaveTextContent(shipped);
  });
});

describe('three reasons there might be no packages, and they differ', () => {
  it('says the PLAN cannot buy them', async () => {
    render(
      await CreditPackagesSection({
        packages: packagesResponseSchema.parse({ packages: [], eligible: false }),
      }),
    );
    expect(screen.getByTestId('packages-ineligible')).toHaveTextContent(/plan does not include/i);
  });

  it('says the SHELF is empty', async () => {
    render(
      await CreditPackagesSection({
        packages: packagesResponseSchema.parse({ packages: [], eligible: true }),
      }),
    );
    const none = screen.getByTestId('packages-none');
    expect(none).toHaveTextContent(/no credit packages on sale/i);
    // And must not blame their plan for an empty catalogue.
    expect(none).not.toHaveTextContent(/your plan/i);
  });

  it('says we could not find out, when the read failed', async () => {
    render(await CreditPackagesSection({ packages: null }));
    const un = screen.getByTestId('packages-unavailable');
    expect(un).toHaveTextContent(/could not load/i);
    expect(un).not.toHaveTextContent(/your plan/i);
  });
});

describe('a package states when its credits die', () => {
  it('carries each expiry policy', async () => {
    render(
      await CreditPackagesSection({
        packages: packagesResponseSchema.parse({
          eligible: true,
          packages: [
            { key: 'a', name: '1,000 credits', credits: 1000, expiryPolicy: 'NEVER' },
            { key: 'b', name: '5,000 credits', credits: 5000, expiryPolicy: 'PERIOD_END' },
            {
              key: 'c',
              name: '20,000 credits',
              credits: 20000,
              expiryPolicy: 'DAYS_AFTER_PURCHASE',
              expiryDays: 90,
            },
          ],
        }),
      }),
    );
    const expiries = screen.getAllByTestId('package-expiry');
    expect(expiries[0]).toHaveTextContent(/do not expire/i);
    expect(expiries[1]).toHaveTextContent(/end of your billing period/i);
    expect(expiries[2]).toHaveTextContent(/90 days after/i);
  });
});
