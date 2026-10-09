import { describe, expect, it } from 'vitest';

import {
  awaitingGrant,
  consumptionIsTrustworthy,
  creditSummarySchema,
  expiringAtRenewal,
  ranWithoutMetering,
  purchasedBalance,
} from './credits';

/** The tenant as measured on 2026-09-23 - every figure from a real row. */
const MEASURED = {
  period: { startsAt: '2026-09-08T00:00:00.000Z', endsAt: '2027-09-08T00:00:00.000Z' },
  plan: { name: 'AI Voice', includedCredits: 7000 },
  // allowance 7000 − remaining 0. 340.01 of it was spent; 6,659.99 EXPIRED.
  usage: { consumedCredits: 7000, remainingPlanCredits: 0, consumedPct: 100 },
  purchasedCredits: { balance: 0 },
  totalAvailableCredits: 0,
  observedRemaining: {
    chats: null,
    basis: null,
    reason: 'no_consumption_recorded',
    creditsPerConversation: null,
    sample: { conversations: 88, creditsConsumed: 0, conversationAttributedPct: 0 },
  },
};

const NOW = new Date('2026-09-23T00:00:00.000Z');

describe('the two buckets expire oppositely', () => {
  it('separates what lapses at renewal from what does not', () => {
    const s = creditSummarySchema.parse({
      usage: { consumedCredits: 100, remainingPlanCredits: 900, consumedPct: 10 },
      purchasedCredits: { balance: 300 },
      totalAvailableCredits: 1200,
    });
    // 1,200 today; at most 300 on renewal day. One total says neither.
    expect(s.totalAvailableCredits).toBe(1200);
    expect(expiringAtRenewal(s)).toBe(900);
    expect(purchasedBalance(s)).toBe(300);
  });
});

describe('consumption that counts expiry as spend is not shown as usage', () => {
  it('refuses the measured 100% bar', () => {
    /*
     * The route reports 7,000 of 7,000 consumed. The ledger says 340 were
     * spent and 6,660 expired. The contradiction is visible in the response
     * alone: a period that began 15 days ago, and zero credits metered in the
     * trailing 30.
     */
    const s = creditSummarySchema.parse(MEASURED);
    expect(s.usage.consumedPct).toBe(100);
    expect(consumptionIsTrustworthy(s, NOW)).toBe(false);
  });

  it('accepts it again as soon as any spend is measured', () => {
    // Not a permanent suppression - it lifts on the route's own evidence.
    const s = creditSummarySchema.parse({
      ...MEASURED,
      observedRemaining: {
        ...MEASURED.observedRemaining,
        sample: { conversations: 88, creditsConsumed: 340, conversationAttributedPct: 76 },
      },
    });
    expect(consumptionIsTrustworthy(s, NOW)).toBe(true);
  });

  it('accepts it for a period older than the window it could be measured in', () => {
    // Spend that predates the window is unmeasurable, not contradicted.
    const s = creditSummarySchema.parse({
      ...MEASURED,
      period: { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' },
    });
    expect(consumptionIsTrustworthy(s, NOW)).toBe(true);
  });

  it('accepts a summary claiming no consumption at all', () => {
    const s = creditSummarySchema.parse({ ...MEASURED, usage: { consumedCredits: 0 } });
    expect(consumptionIsTrustworthy(s, NOW)).toBe(true);
  });
});

describe('a contracted allowance with nothing granted is not a spent one', () => {
  it('reports the measured tenant as awaiting its grant', () => {
    // 7,000 contracted since 8 September; the only lot ever granted expired
    // on 28 August, and the balance snapshot still says period 2026-07.
    expect(awaitingGrant(creditSummarySchema.parse(MEASURED))).toBe(true);
  });

  it('does not report a tenant that is merely holding credits', () => {
    const s = creditSummarySchema.parse({
      ...MEASURED,
      usage: { consumedCredits: 100, remainingPlanCredits: 900, consumedPct: 10 },
      totalAvailableCredits: 900,
    });
    expect(awaitingGrant(s)).toBe(false);
  });
});

describe('no_consumption_recorded is about metering, not activity', () => {
  it('holds the 88 conversations that the reason code does not mention', () => {
    const s = creditSummarySchema.parse(MEASURED);
    expect(ranWithoutMetering(s)).toBe(true);
    expect(s.observedRemaining.sample.conversations).toBe(88);
  });

  it('is not claimed for a tenant that genuinely did nothing', () => {
    const s = creditSummarySchema.parse({
      ...MEASURED,
      observedRemaining: { ...MEASURED.observedRemaining, sample: { conversations: 0 } },
    });
    expect(ranWithoutMetering(s)).toBe(false);
  });

  it('is not claimed when the rate failed for want of a sample', () => {
    // A different reason and a different sentence: 12 conversations is too
    // few to extrapolate, which is not the same as nothing being metered.
    const s = creditSummarySchema.parse({
      ...MEASURED,
      observedRemaining: {
        ...MEASURED.observedRemaining,
        reason: 'not_enough_conversations',
        sample: { conversations: 12, creditsConsumed: 48, conversationAttributedPct: 80 },
      },
    });
    expect(ranWithoutMetering(s)).toBe(false);
  });
});

describe('the platform ships its own disclaimer', () => {
  it('carries both locales rather than re-translating the commercial copy', () => {
    const s = creditSummarySchema.parse({
      ...MEASURED,
      disclaimer: {
        en: 'Conversation estimates are based on the plan configuration.',
        he: 'הערכות',
      },
    });
    expect(s.disclaimer?.he).toBe('הערכות');
    // Absent is null, so the screen can fall back rather than print "".
    expect(creditSummarySchema.parse({}).disclaimer).toBeNull();
  });
});
