import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Plan, Subscription } from '@/api/contracts/billing';
import messages from '@/i18n/messages/en/billing.json';

import { PlanLine } from './BillingSections';

/**
 * The scheduled-change line on screen 17, which had no test and was wrong.
 *
 * `PlanLine` rendered `subscription.pendingChange?.targetPlanKey` — presence,
 * not pendency. The scheduler **marks** `appliedAt` and never deletes the row
 * (`subscription.service.ts:524`), and `getSubscriptionForTenant` loads the
 * relation unconditionally, so a change applied a year ago arrives on every
 * response indistinguishable from one that has not happened yet.
 *
 * The screen would have gone on announcing *"Changes to Foundation at
 * renewal"* every day **after** it already changed to Foundation.
 *
 * It survived acceptance because `appliedAt` was not in our contract. Nothing
 * on this screen could have surfaced it: the field the bug turns on did not
 * exist here to be got wrong. It was found reading the same table for 17b.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
  getLocale: async () => 'en',
}));

const PLANS: readonly Plan[] = [
  { key: 'ai_voice', name: 'AI Voice', nameHe: null },
  { key: 'foundation', name: 'Foundation', nameHe: null },
];

const subscription = (pendingChange: Subscription['pendingChange']): Subscription => ({
  planKey: 'ai_voice',
  status: 'ACTIVE',
  snapshotPrice: '1499.00',
  snapshotCurrency: 'USD',
  currentPeriodEnd: '2027-09-08T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  billingInterval: 'YEAR',
  pendingChange,
});

const SCHEDULED = {
  changeType: 'DOWNGRADE' as const,
  targetPlanKey: 'foundation',
  effectiveAt: '2027-09-08T00:00:00.000Z',
  appliedAt: null,
};

async function renderPlan(pendingChange: Subscription['pendingChange']) {
  render(await PlanLine({ subscription: subscription(pendingChange), plans: PLANS }));
}

describe('a change that has already been applied is not announced', () => {
  it('announces one that is still coming', async () => {
    await renderPlan(SCHEDULED);
    expect(screen.getByTestId('plan-pending')).toHaveTextContent(/Foundation/);
  });

  it('says NOTHING once the scheduler has applied it', async () => {
    // The row persists with `appliedAt` set. This is the whole bug.
    await renderPlan({ ...SCHEDULED, appliedAt: '2027-09-08T02:00:00.000Z' });
    expect(screen.queryByTestId('plan-pending')).toBeNull();
  });

  it('says nothing when no change is scheduled', async () => {
    await renderPlan(null);
    expect(screen.queryByTestId('plan-pending')).toBeNull();
  });
});

describe('the plan line names the plan rather than its key', () => {
  it('resolves the scheduled plan to a name too', async () => {
    await renderPlan(SCHEDULED);
    // `foundation` is a machine identifier; it must not reach the screen.
    expect(screen.getByTestId('plan-pending')).not.toHaveTextContent(/foundation/);
  });

  it('renders the current plan and its real price', async () => {
    await renderPlan(null);
    expect(screen.getByTestId('plan-name')).toHaveTextContent('AI Voice');
    // $1,499.00 USD is what this tenant is charged. Not the design's mockup.
    expect(screen.getByTestId('plan')).toHaveTextContent(/\$1,499/);
  });
});

describe('★ 17b is reached from the plan, not from the nav', () => {
  it('"Change plan" goes to the plan sub-page', async () => {
    render(
      await PlanLine({
        subscription: { planKey: 'starter' } as unknown as Subscription,
        plans: [],
      }),
    );
    expect(screen.getByTestId('plan-change')).toHaveAttribute('href', '/settings/billing/plan');
  });
});
