import { describe, expect, it } from 'vitest';

import {
  classifyChangeError,
  creditPackageSchema,
  creditsGrantedOnUpgrade,
  currencyBlockSchema,
  isStillPending,
  mayRetry,
  noneOnSale,
  packagesResponseSchema,
  pendingChangeSchema,
  planCannotBuyPackages,
  priceIsConverted,
  rateIsFallback,
  upgradeWillBeDeclined,
} from './pricing';

describe('a scheduled change that already happened is not scheduled', () => {
  const scheduled = {
    changeType: 'DOWNGRADE',
    targetPlanKey: 'foundation',
    effectiveAt: '2027-09-08T00:00:00.000Z',
  };

  it('counts an unapplied change as pending', () => {
    expect(isStillPending(pendingChangeSchema.parse(scheduled))).toBe(true);
  });

  it('does NOT count one the scheduler has applied', () => {
    /*
     * subscription.service.ts:524 marks `appliedAt` and never deletes the
     * row, and `getSubscriptionForTenant` includes the relation
     * unconditionally. Reading presence as pendency would render "changes to
     * Foundation on 8 September 2027" every day after it already did.
     */
    const applied = pendingChangeSchema.parse({
      ...scheduled,
      appliedAt: '2027-09-08T02:00:00.000Z',
    });
    expect(isStillPending(applied)).toBe(false);
  });

  it('treats an absent change as nothing scheduled', () => {
    expect(isStillPending(null)).toBe(false);
  });

  it('keeps CANCEL distinguishable from a plan change', () => {
    // "Your subscription ends" is not "your plan changes".
    const cancel = pendingChangeSchema.parse({ ...scheduled, changeType: 'CANCEL' });
    expect(cancel.changeType).toBe('CANCEL');
  });
});

describe('displayed currency is not charged currency', () => {
  it('flags a price the customer will not be charged in', () => {
    const c = currencyBlockSchema.parse({
      base: 'USD',
      display: 'ILS',
      chargedCurrency: 'USD',
      isEstimatedConversion: true,
      fx: { rate: 3.72, rateDate: '2026-09-22', isFallback: false },
    });
    expect(priceIsConverted(c)).toBe(true);
    expect(rateIsFallback(c)).toBe(false);
  });

  it('flags a conversion resting on a fallback rate', () => {
    // A fallback rate is not a rate. Shown as such, or not shown.
    const c = currencyBlockSchema.parse({
      display: 'ILS',
      chargedCurrency: 'USD',
      isEstimatedConversion: true,
      fx: { rate: 3.6, rateDate: null, isFallback: true },
    });
    expect(rateIsFallback(c)).toBe(true);
  });

  it('leaves a price in the charged currency alone', () => {
    const c = currencyBlockSchema.parse({ display: 'USD', chargedCurrency: 'USD' });
    expect(priceIsConverted(c)).toBe(false);
  });
});

describe('two different empties on the packages route', () => {
  it('separates a plan that cannot buy from a catalogue with nothing in it', () => {
    const ineligible = packagesResponseSchema.parse({ packages: [], eligible: false });
    const empty = packagesResponseSchema.parse({ packages: [], eligible: true });

    expect(planCannotBuyPackages(ineligible)).toBe(true);
    expect(noneOnSale(ineligible)).toBe(false);

    expect(planCannotBuyPackages(empty)).toBe(false);
    expect(noneOnSale(empty)).toBe(true);
  });

  it('is neither when there is something to buy', () => {
    const r = packagesResponseSchema.parse({
      eligible: true,
      packages: [{ key: 'credits_1000', name: '1,000 credits', credits: 1000 }],
    });
    expect(planCannotBuyPackages(r)).toBe(false);
    expect(noneOnSale(r)).toBe(false);
  });
});

describe('a package carries the only expiry a customer will ever see', () => {
  it('defaults to NEVER and keeps the two that are not', () => {
    // All four sellable packages are NEVER today. The enum has three values
    // and purchase.service.ts honours all of them.
    expect(creditPackageSchema.parse({ key: 'k', name: 'n' }).expiryPolicy).toBe('NEVER');
    const periodEnd = creditPackageSchema.parse({
      key: 'k',
      name: 'n',
      expiryPolicy: 'PERIOD_END',
    });
    expect(periodEnd.expiryPolicy).toBe('PERIOD_END');
  });
});

describe('an unsettled charge is not a failure', () => {
  it('never classifies the unknown outcome as a payment failure', () => {
    expect(classifyChangeError('upgrade_payment_outcome_unknown')).toBe('outcome_unknown');
    expect(classifyChangeError('upgrade_payment_failed:card_declined')).toBe('payment_failed');
    expect(classifyChangeError('no_subscription')).toBe('other');
  });

  it('refuses a retry affordance for it, and allows one otherwise', () => {
    /*
     * "they may have been charged, and 'failed' invites them to try again."
     * A retry here can take the money twice.
     */
    expect(mayRetry('upgrade_payment_outcome_unknown')).toBe(false);
    expect(mayRetry('upgrade_payment_failed:card_declined')).toBe(true);
    expect(mayRetry('no_subscription')).toBe(true);
  });
});

describe('what an upgrade actually does', () => {
  it('knows the charge will be declined with no card on file', () => {
    // `pmKey = paymentMethods[0]?.id ?? "nocard"`, charged BEFORE anything is
    // granted. This tenant has zero payment methods.
    expect(upgradeWillBeDeclined(0)).toBe(true);
    expect(upgradeWillBeDeclined(1)).toBe(false);
  });

  it('grants the delta against the existing allowance, not the whole plan', () => {
    // 2,000 already allowed, upgrading to 7,000 grants 5,000.
    expect(creditsGrantedOnUpgrade(7000, 2000)).toBe(5000);
    // And never negative when the allowance already exceeds the target.
    expect(creditsGrantedOnUpgrade(2000, 7000)).toBe(0);
  });
});
