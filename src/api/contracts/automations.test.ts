import { describe, expect, it } from 'vitest';

import {
  appliesToChannel,
  automationListSchema,
  automationSchema,
  hasEverRun,
  type Automation,
} from './automations';

/** The rulings on screen 09, as assertions. This tenant has zero flows. */

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: 'f1',
  name: 'A customer wants to cancel',
  description: 'Finds the order and checks if it shipped',
  isActive: true,
  channel: null,
  trigger: null,
  runCount: 46,
  updatedAt: null,
  ...over,
});

describe('the response is a bare array', () => {
  it('parses without an envelope', () => {
    // Fourth response shape on this platform, after { data },
    // { data, nextCursor } and bare { subscription }.
    const parsed = automationListSchema.parse([automation()]);
    expect(parsed).toHaveLength(1);
  });
});

describe('the count is for all time', () => {
  it('carries runCount and nothing period-shaped', () => {
    /*
     * The design says "Ran 46 times THIS WEEK" and "handled 1,204 things this
     * week". `runCount` is cumulative with no clock, and there are no run
     * records to derive a period from — so a weekly field here would be
     * inventing one.
     */
    const surface = Object.keys(automationSchema.parse(automation()));
    expect(surface.filter((k) => /week|month|today|period|since/i.test(k))).toEqual([]);
    expect(surface).toContain('runCount');
  });

  it('separates never-run from a count of zero', () => {
    // An automation that is on and has never fired usually means its trigger
    // never matches — the interesting row on this screen, and a bare 0 in a
    // column would not be noticed.
    expect(hasEverRun(automation({ runCount: 0 }))).toBe(false);
    expect(hasEverRun(automation({ runCount: 1 }))).toBe(true);
  });
});

describe('a flow covers one channel or all of them', () => {
  it('reports the single channel when there is one', () => {
    expect(appliesToChannel(automation({ channel: 'WHATSAPP' }))).toBe('WHATSAPP');
  });

  it('reports null for all channels rather than enumerating them', () => {
    // The model says "all", not "these eight". Listing every known channel
    // would invent a specificity the flow does not have — and would go stale
    // the moment a channel is added.
    expect(appliesToChannel(automation({ channel: null }))).toBeNull();
  });
});

describe('an automation carries nothing that could become a false claim', () => {
  it('exposes no revenue, no actor, no pause timestamp', () => {
    /*
     * "₪12,400 recovered" is attributed revenue — FIFTH appearance across
     * five screens, still with no inputs. "Paused by you on 12 Aug" needs an
     * actor and a timestamp; `isActive` is a bare boolean.
     */
    const surface = Object.keys(automationSchema.parse(automation()));
    expect(
      surface.filter((k) => /revenue|recovered|pausedBy|pausedAt|actor|stopReason/i.test(k)),
    ).toEqual([]);
  });

  it('exposes no run history', () => {
    // There are no run-record models of any kind, so stop-reason clustering
    // has nothing to cluster — a consequence of the absence, not a second
    // finding.
    const surface = Object.keys(automationSchema.parse(automation()));
    expect(surface.filter((k) => /runs$|history|executions/i.test(k))).toEqual([]);
  });
});
