import { describe, expect, it } from 'vitest';

import { campaignSchema, isInFlight, isStoppable, shareOfSent, type Campaign } from './outreach';

/**
 * The rulings on screens 05 and 05b, as assertions.
 *
 * This tenant has zero campaigns, so a capture photographs the empty state and
 * none of this. These tests are the only place the judgements are checked.
 */

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: 'b1',
  name: 'Linen restock',
  channel: 'WHATSAPP',
  status: 'COMPLETED',
  scheduledAt: null,
  startedAt: null,
  completedAt: null,
  createdAt: '2026-09-20T09:00:00.000Z',
  totalRecipients: 1240,
  sentCount: 1240,
  /*
   * ⚠ ZERO, BECAUSE THAT IS WHAT THE PLATFORM PRODUCES.
   *
   * These were 1228 / 904 / 188 — a fixture asserting the system can emit
   * values it cannot. Nothing increments these three counters, so any test
   * built on them proves arithmetic and nothing about the product.
   */
  deliveredCount: 0,
  readCount: 0,
  repliedCount: 0,
  failedCount: 12,
  lastError: null,
  ...over,
});

describe('the contract strips what no card needs', () => {
  it('drops audience, variables and the routing internals', () => {
    // `audience` is arbitrary JSON describing WHO is being messaged, and
    // nothing on the card reads it.
    const parsed = campaignSchema.parse({
      ...campaign(),
      audience: { rules: [{ field: 'email', value: 'someone@example.com' }] },
      variables: { name: 'Dana' },
      channelAccountId: 'acc_1',
      flowId: 'flow_1',
      createdBy: 'u1',
      tenantId: 't1',
    });

    for (const key of ['audience', 'variables', 'channelAccountId', 'flowId', 'createdBy'])
      expect(parsed, `${key} must not survive the contract`).not.toHaveProperty(key);
  });

  it('keeps failedCount and lastError, which the design never asked for', () => {
    const parsed = campaignSchema.parse(campaign({ failedCount: 12, lastError: 'billing issue' }));
    expect(parsed.failedCount).toBe(12);
    expect(parsed.lastError).toBe('billing issue');
  });
});

describe('isStoppable — only what the route will accept', () => {
  it('offers the control while sending or scheduled', () => {
    expect(isStoppable(campaign({ status: 'SENDING' }))).toBe(true);
    expect(isStoppable(campaign({ status: 'SCHEDULED' }))).toBe(true);
  });

  it('refuses on everything else, which the route answers 400 for', () => {
    for (const status of ['DRAFT', 'COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(isStoppable(campaign({ status })), status).toBe(false);
    }
  });

  it('exposes no pause or resume anywhere in the surface', () => {
    // There is no PAUSED status and no resume route. A function named for
    // pausing is how the label gets trusted — "pause" promises that it halts
    // AND that it resumes, and only the first is true.
    const surface = Object.keys(campaignSchema.parse(campaign()));
    expect(surface.filter((k) => /pause|resume|suspend/i.test(k))).toEqual([]);
  });
});

/*
 * ★★ `openedWithoutReplying` HAD TWO TESTS HERE AND BOTH PASSED FOREVER.
 *
 * Its describe block was headed "two real numbers beating a fictional one",
 * and the fixture used `readCount: 904, repliedCount: 188` — values the
 * platform cannot produce. `deliveredCount`, `readCount` and `repliedCount`
 * are initialised to zero and nothing in the monorepo increments them.
 *
 * So the tests asserted arithmetic on data the system never emits. They were
 * correct about subtraction and silent about the product, and they would
 * have gone on passing for as long as anybody kept them.
 *
 * **A fixture is a claim that the system can produce these values.** That
 * claim is worth checking, and nothing here was checking it.
 *
 * Removed with the function and its screen.
 */

describe('shareOfSent — denominated on what was actually sent', () => {
  it('divides by sentCount, not by the intended audience', () => {
    // Nobody can be delivered to among people the campaign never sent to.
    // Dividing by totalRecipients would understate every rate on a campaign
    // that is still sending.
    const half = campaign({ totalRecipients: 1000, sentCount: 500, deliveredCount: 250 });
    expect(shareOfSent(half.deliveredCount, half)).toBe(0.5);
  });

  it('is null rather than zero before anything has been sent', () => {
    // "Nothing sent yet" and "0% of what was sent" are different facts, and a
    // row of 0% on a campaign that has not started is the kind of number
    // somebody screenshots.
    expect(shareOfSent(0, campaign({ sentCount: 0, status: 'SCHEDULED' }))).toBeNull();
  });
});

describe('a campaign carries no field that could become a false claim', () => {
  it('exposes nothing resembling conversion, revenue or opt-outs', () => {
    // None is a concept in this platform. Attributed revenue has no inputs at
    // all and this is its third appearance across three screens.
    const surface = Object.keys(campaignSchema.parse(campaign()));
    expect(surface.filter((k) => /convert|bought|revenue|value|optedOut|optOut/i.test(k))).toEqual(
      [],
    );
  });

  it('splits in-flight from finished the way the statuses do', () => {
    expect(isInFlight(campaign({ status: 'SENDING' }))).toBe(true);
    expect(isInFlight(campaign({ status: 'SCHEDULED' }))).toBe(true);
    expect(isInFlight(campaign({ status: 'CANCELLED' }))).toBe(false);
    expect(isInFlight(campaign({ status: 'DRAFT' }))).toBe(false);
  });
});
