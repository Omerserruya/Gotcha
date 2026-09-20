import { describe, expect, it } from 'vitest';

import {
  campaignSchema,
  isInFlight,
  isStoppable,
  openedWithoutReplying,
  shareOfSent,
  type Campaign,
} from './outreach';

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
  deliveredCount: 1228,
  readCount: 904,
  repliedCount: 188,
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

describe('openedWithoutReplying — two real numbers beating a fictional one', () => {
  it('is read minus replied', () => {
    expect(openedWithoutReplying(campaign({ readCount: 904, repliedCount: 188 }))).toBe(716);
  });

  it('never goes negative when a reply beats its own read receipt', () => {
    // The two counters are written by different paths, so a reply can be
    // recorded before the read that preceded it.
    expect(openedWithoutReplying(campaign({ readCount: 3, repliedCount: 5 }))).toBe(0);
  });
});

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
