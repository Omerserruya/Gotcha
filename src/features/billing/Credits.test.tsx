import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { creditSummarySchema } from '@/api/contracts/credits';
import messages from '@/i18n/messages/en/billing.json';

import { CreditsSection } from './Credits';

/**
 * Screen 17c.
 *
 * The state this tenant is actually in is the one the design has no picture
 * of: a contracted allowance with nothing granted, a consumption figure that
 * counts expiry as spend, and a reason code that says "no consumption
 * recorded" beside 88 conversations.
 *
 * `consumptionIsTrustworthy` takes `now`, and these fix it, so the suite does
 * not start failing in thirty days when the window slides past the period.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing.credits') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
  getLocale: async () => 'en',
}));

const NOW = new Date('2026-09-23T00:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The tenant as measured: every figure from a real row. */
const MEASURED = {
  period: {
    startsAt: '2026-09-08T00:00:00.000Z',
    endsAt: '2027-09-08T00:00:00.000Z',
    resetsAt: '2027-09-08T00:00:00.000Z',
  },
  plan: { name: 'AI Voice', includedCredits: 7000 },
  // 7,000 - 0. Of which 340.01 was spent and 6,659.99 EXPIRED.
  usage: { consumedCredits: 7000, remainingPlanCredits: 0, consumedPct: 100 },
  purchasedCredits: { balance: 0 },
  totalAvailableCredits: 0,
  estimatedRemaining: { chats: 0, calls: 0 },
  observedRemaining: {
    chats: null,
    basis: null,
    reason: 'no_consumption_recorded',
    creditsPerConversation: null,
    sample: { conversations: 88, creditsConsumed: 0, conversationAttributedPct: 0 },
  },
};

const render17c = async (over: Record<string, unknown> = {}) =>
  render(await CreditsSection({ credits: creditSummarySchema.parse({ ...MEASURED, ...over }) }));

describe('the usage figure is withheld, and the screen says so', () => {
  it('withholds it on the measured tenant', async () => {
    await render17c();
    expect(screen.getByTestId('credits')).toHaveAttribute('data-consumption', 'withheld');

    const said = screen.getByTestId('credits-consumption-withheld');
    /*
     * Said, not silently omitted. A missing usage figure on a billing screen
     * looks like a loading failure; this names it as a refusal and why.
     */
    expect(said).toHaveTextContent(/expired credits as if they had been spent/i);
  });

  it('never renders the 100% the route reports', async () => {
    await render17c();
    // The whole point. 5% used, reported as 100%.
    expect(screen.getByTestId('credits')).not.toHaveTextContent(/100\s?%/);
  });

  it('shows it again once real spend is measured', async () => {
    const shown = await render17c({
      observedRemaining: {
        ...MEASURED.observedRemaining,
        sample: { conversations: 88, creditsConsumed: 340, conversationAttributedPct: 76 },
      },
    });
    expect(shown.getByTestId('credits')).toHaveAttribute('data-consumption', 'shown');
    expect(shown.queryByTestId('credits-consumption-withheld')).toBeNull();
  });
});

describe('a contracted allowance with nothing granted is not a spent one', () => {
  it('says the credits have not been issued, and names the contract', async () => {
    await render17c();
    const notice = screen.getByTestId('credits-awaiting-grant');
    expect(notice).toHaveTextContent(/have been issued/i);
    expect(notice).toHaveTextContent(/7,000/);
    // And explicitly denies the reading a bare zero invites.
    expect(notice).toHaveTextContent(/not credits you have spent/i);
  });

  it('says nothing of the sort for a tenant holding credits', async () => {
    const held = await render17c({
      usage: { consumedCredits: 100, remainingPlanCredits: 900, consumedPct: 10 },
      totalAvailableCredits: 900,
    });
    expect(held.queryByTestId('credits-awaiting-grant')).toBeNull();
  });
});

describe('the two buckets do not share a fate', () => {
  it('names the expiring half with the date it expires', async () => {
    const split = await render17c({
      usage: { consumedCredits: 100, remainingPlanCredits: 900, consumedPct: 10 },
      purchasedCredits: { balance: 300 },
      totalAvailableCredits: 1200,
    });
    expect(split.getByTestId('credits-balance')).toHaveTextContent('1,200');
    const expiring = split.getByTestId('credits-expiring');
    expect(expiring).toHaveTextContent('900');
    expect(expiring).toHaveTextContent(/expire/i);
    // The year, present rather than formatted.
    expect(expiring).toHaveTextContent(/2027/);
    expect(split.getByTestId('credits-purchased')).toHaveTextContent('300');
  });

  it('makes no promise that the purchased half is permanent', async () => {
    /*
     * `CreditExpiryPolicy` has PERIOD_END, and the summary route strips
     * `expiresAt` from the lots — so the screen cannot know, and must not say.
     */
    const split = await render17c({
      purchasedCredits: { balance: 300 },
      totalAvailableCredits: 300,
    });
    expect(split.getByTestId('credits-purchased')).not.toHaveTextContent(
      /never|permanent|forever/i,
    );
  });
});

describe('an estimate always says what it rests on', () => {
  it('labels the tenant’s own measured rate as their own', async () => {
    const measured = await render17c({
      usage: { consumedCredits: 100, remainingPlanCredits: 900, consumedPct: 10 },
      totalAvailableCredits: 900,
      observedRemaining: {
        chats: 120,
        basis: 'TENANT_ACTUAL',
        reason: null,
        creditsPerConversation: 7.5,
        sample: { conversations: 88, creditsConsumed: 660, conversationAttributedPct: 76 },
      },
    });
    expect(measured.getByTestId('credits-estimate-observed')).toHaveTextContent(
      /actually been using/i,
    );
    expect(measured.getByTestId('credits-estimate-basis')).toHaveTextContent(/your own usage/i);
    // And names how much of the burn the per-conversation figure describes.
    expect(measured.getByTestId('credits-attribution')).toHaveTextContent(/76%/);
  });

  it('labels the plan’s published rate as NOT the tenant’s usage', async () => {
    const planRate = await render17c({
      usage: { consumedCredits: 100, remainingPlanCredits: 900, consumedPct: 10 },
      totalAvailableCredits: 900,
      estimatedRemaining: { chats: 112, calls: 45 },
    });
    expect(planRate.getByTestId('credits-estimate-plan')).toHaveTextContent(/112/);
    const basis = planRate.getByTestId('credits-estimate-basis');
    expect(basis).toHaveTextContent(/plan's published rate/i);
    // The route forbids swapping the two, so this must say it is not theirs.
    expect(basis).toHaveTextContent(/not on your own usage/i);
  });
});

describe('“no consumption recorded” is about metering, not activity', () => {
  it('states the conversations that the reason code omits', async () => {
    await render17c();
    const note = screen.getByTestId('credits-no-metering');
    expect(note).toHaveTextContent(/88 conversations/);
    expect(note).toHaveTextContent(/no credits were recorded/i);
    // The sentence that stops it being read as "you have not used GOTCHA".
    expect(note).toHaveTextContent(/not about how much you have used/i);
  });

  it('uses a different sentence when the sample is merely too small', async () => {
    const few = await render17c({
      observedRemaining: {
        ...MEASURED.observedRemaining,
        reason: 'not_enough_conversations',
        sample: { conversations: 12, creditsConsumed: 48, conversationAttributedPct: 80 },
      },
    });
    expect(few.queryByTestId('credits-no-metering')).toBeNull();
    expect(few.getByTestId('credits-too-few')).toHaveTextContent(/too few to measure/i);
  });
});

describe('a failed read is not a balance of zero', () => {
  it('says we could not load them', async () => {
    render(await CreditsSection({ credits: null }));
    expect(screen.getByTestId('credits-unavailable')).toHaveTextContent(/could not load/i);
  });
});
