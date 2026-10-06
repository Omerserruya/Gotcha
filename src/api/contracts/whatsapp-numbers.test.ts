import { describe, expect, it } from 'vitest';

import {
  advisoryChecks,
  blockingChecks,
  deliveryState,
  fixableHere,
  hasAnyAction,
  healthReportSchema,
  numbersResponseSchema,
} from './whatsapp-numbers';

const health = (over: Record<string, unknown> = {}) =>
  healthReportSchema.parse({ state: 'CONNECTED', receiving: true, sending: true, ...over });

describe('receiving and sending fail separately', () => {
  it('calls a number that does both working', () => {
    expect(deliveryState(health())).toBe('working');
  });

  it('★ calls a number Meta has blocked outbound INBOUND_ONLY, not down', () => {
    /*
     * The bug the platform's own comment records: folding the two into one
     * verdict "reported that number as '0 working, 1 needs attention' to a
     * customer whose inbox was filling up."
     *
     * It is doing half its job, and the half it is doing is the one the
     * customer's inbox depends on.
     */
    const blocked = health({ receiving: true, sending: false, ready: false, state: 'DEGRADED' });
    expect(deliveryState(blocked)).toBe('inbound_only');
    expect(deliveryState(blocked)).not.toBe('down');
  });

  it('does not take `ready` for the answer', () => {
    // `ready` is false here and the number is still receiving. A card bound
    // to `ready` alone would say nothing is working.
    const blocked = health({ receiving: true, sending: false, ready: false });
    expect(blocked.ready).toBe(false);
    expect(deliveryState(blocked)).toBe('inbound_only');
  });

  it('calls a genuinely dead number down', () => {
    expect(deliveryState(health({ receiving: false, sending: false }))).toBe('down');
  });
});

describe('what stops messages today leads, and the rest is not discarded', () => {
  const checks = [
    { id: 'REGISTRATION' as const, label: 'Registration', status: 'FAIL' as const, blocking: true },
    { id: 'QUALITY' as const, label: 'Quality', status: 'WARN' as const, blocking: false },
    { id: 'WEBHOOKS' as const, label: 'Webhooks', status: 'PASS' as const, blocking: true },
  ];

  it('separates the blocking failure from the advisory one', () => {
    const h = health({ checks });
    expect(blockingChecks(h).map((c) => c.id)).toEqual(['REGISTRATION']);
    expect(advisoryChecks(h).map((c) => c.id)).toEqual(['QUALITY']);
  });

  it('never reports a PASS as a problem, whichever kind it is', () => {
    // WEBHOOKS is blocking AND passing. It is not a finding.
    const h = health({ checks });
    expect(blockingChecks(h).some((c) => c.id === 'WEBHOOKS')).toBe(false);
    expect(advisoryChecks(h).some((c) => c.id === 'WEBHOOKS')).toBe(false);
  });
});

describe('three remediation buckets, not two', () => {
  it('offers a control only for the one the customer can clear HERE', () => {
    /*
     * Error 141000 - Meta has the number, it was never registered for Cloud
     * API. `resume` runs the register step from inside GOTCHA. Everything
     * else in a blocked report is resolved in Meta's own settings.
     */
    const registrable = health({
      receiving: true,
      sending: false,
      needsRegistration: true,
      availableRepairs: [],
    });
    expect(fixableHere(registrable)).toBe(true);
    expect(hasAnyAction(registrable)).toBe(true);
  });

  it('offers nothing when every problem lives in Meta', () => {
    // "so the UI never offers a button that cannot work; offering one and
    // having it fail is worse than saying plainly that this one is theirs."
    const theirs = health({
      receiving: false,
      sending: false,
      needsRegistration: false,
      availableRepairs: [],
      customerActions: [
        { id: 'VERIFICATION', label: 'Business verification', status: 'FAIL', blocking: true },
      ],
    });
    expect(fixableHere(theirs)).toBe(false);
    expect(hasAnyAction(theirs)).toBe(false);
  });

  it('offers our own repairs when we have any', () => {
    expect(hasAnyAction(health({ availableRepairs: ['REFRESH_STATUS'] }))).toBe(true);
  });
});

describe('the two arrays are not the same kind of thing', () => {
  it('keeps a legacy channel out of the managed list', () => {
    /*
     * This tenant's real response: no lifecycle rows at all, and one WhatsApp
     * channel connected before per-number health existed. It is working, and
     * NOTHING is known about it - which is not the same as healthy and not
     * the same as broken.
     */
    const r = numbersResponseSchema.parse({
      data: [],
      unprofiled: [
        {
          channelAccountId: 'ca1',
          phoneNumberId: '1010938148762991',
          name: 'Demo WhatsApp',
          connectionStatus: 'CONNECTED',
          note: 'Connected before per-number health was available.',
        },
      ],
    });
    expect(r.data).toHaveLength(0);
    expect(r.unprofiled).toHaveLength(1);
    // And it carries no health, so there is nothing to derive a verdict from.
    expect(r.unprofiled[0]).not.toHaveProperty('health');
  });

  it('defaults both arrays rather than leaving them undefined', () => {
    const empty = numbersResponseSchema.parse({});
    expect(empty.data).toEqual([]);
    expect(empty.unprofiled).toEqual([]);
  });
});
