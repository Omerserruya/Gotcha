import { describe, expect, it } from 'vitest';

import {
  aiKeepsAnswering,
  autoPurchaseResponseSchema,
  autoPurchaseSchema,
  capUsed,
  LIMIT_BEHAVIORS,
  spendsPastZero,
  type AutoPurchase,
} from './auto-purchase';

const policy = (over: Partial<AutoPurchase> = {}): AutoPurchase =>
  autoPurchaseSchema.parse({
    enabled: true,
    thresholdPct: 10,
    warningThresholdPct: 80,
    maxMonthlySpend: '500.00',
    monthSpentAmount: '110.00',
    limitBehavior: 'STOP_AI',
    ...over,
  });

describe('five behaviours, not four, and not a list of equals', () => {
  it('carries all five the platform defines', () => {
    expect([...LIMIT_BEHAVIORS]).toEqual([
      'STOP_AI',
      'HUMAN_ONLY',
      'REQUIRE_APPROVAL',
      'PREPAID_ONLY',
      'PAYG',
    ]);
  });

  it('knows which one keeps spending after the credit runs out', () => {
    /*
     * The distinction a merchant setting a cap actually needs. PAYG serves
     * past zero and bills afterwards, so a cap plus PAYG DOES NOT CAP THE
     * BILL. Every other behaviour stops something instead.
     */
    expect(spendsPastZero('PAYG')).toBe(true);
    for (const b of ['STOP_AI', 'HUMAN_ONLY', 'REQUIRE_APPROVAL', 'PREPAID_ONLY'] as const) {
      expect(spendsPastZero(b), b).toBe(false);
    }
  });

  it('knows which ones leave the AI answering customers', () => {
    // REQUIRE_APPROVAL keeps the AI working with a person in the loop; PAYG
    // keeps it working and bills. The other three stop it.
    expect(aiKeepsAnswering('REQUIRE_APPROVAL')).toBe(true);
    expect(aiKeepsAnswering('PAYG')).toBe(true);
    expect(aiKeepsAnswering('STOP_AI')).toBe(false);
    expect(aiKeepsAnswering('HUMAN_ONLY')).toBe(false);
  });

  it('falls back to the platform default rather than inventing one', () => {
    expect(autoPurchaseSchema.parse({ limitBehavior: 'SOMETHING_NEW' }).limitBehavior).toBe(
      'STOP_AI',
    );
  });
});

describe('the cap', () => {
  it('reports how much of it is spent', () => {
    expect(capUsed(policy())).toBeCloseTo(0.22);
  });

  it('is null with no cap set, never zero', () => {
    /*
     * "No limit set" and "nothing spent against the limit" are different
     * facts. A bar at 0% would state the second about a tenant in the first
     * position — the same distinction as a send rate before anything is sent.
     */
    expect(capUsed(policy({ maxMonthlySpend: null }))).toBeNull();
  });

  it('is null rather than Infinity on a zero cap', () => {
    expect(capUsed(policy({ maxMonthlySpend: '0.00' }))).toBeNull();
  });
});

describe('two thresholds, not one', () => {
  it('keeps the warning separate from the trigger', () => {
    // A warning that fires at the same moment as the action it warns about
    // is not a warning. 80% tells the owner; 10% buys.
    const p = policy();
    expect(p.warningThresholdPct).toBe(80);
    expect(p.thresholdPct).toBe(10);
    expect(p.warningThresholdPct).toBeGreaterThan(p.thresholdPct);
  });
});

describe('no policy is not a policy of defaults', () => {
  it('keeps null distinct from a configured row', () => {
    const parsed = autoPurchaseResponseSchema.parse({
      policy: null,
      currency: 'USD',
      paygRate: null,
    });
    expect(parsed.policy).toBeNull();
    // The currency still travels, so an amount can be named before anything
    // is set up.
    expect(parsed.currency).toBe('USD');
  });
});
