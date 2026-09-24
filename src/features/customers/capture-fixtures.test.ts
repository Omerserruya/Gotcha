import { describe, expect, it, vi } from 'vitest';

import type { CustomerRow } from '@/api/contracts/customers';

import type { CustomerDetail } from './load-customer';

import { FIXTURE_MARKER, withCaptureFixtures, withDetailFixtures } from './capture-fixtures';

const { enabled } = vi.hoisted(() => ({ enabled: vi.fn() }));
vi.mock('@/features/security/capture-fixtures', () => ({ captureFixturesEnabled: enabled }));

/**
 * The substitution, in both directions.
 *
 * The gate itself (`captureFixturesEnabled`) has its own test in the security
 * feature and is not re-tested here — it is imported unchanged precisely so
 * there is one mechanism rather than two that can drift. What is tested here
 * is that this screen uses it correctly, and that a broken read stays broken.
 */

const real: CustomerRow[] = [
  {
    id: 'real-1',
    externalId: '+972500000000',
    displayName: 'A Real Person',
    channel: 'WHATSAPP',
    phone: '+972500000000',
    email: 'real@a-real-domain.example',
    tags: [],
    lastInteractionAt: null,
    source: null,
    personId: null,
    mergedIntoId: null,
  },
];

describe('withCaptureFixtures', () => {
  it('leaves the real list alone when the gate is shut', () => {
    enabled.mockReturnValue(false);
    expect(withCaptureFixtures(real, '')).toBe(real);
  });

  it('substitutes when the gate is open', () => {
    enabled.mockReturnValue(true);
    const rows = withCaptureFixtures(real, '');
    expect(rows).not.toBe(real);
    expect(rows!.some((r) => r.email?.includes(FIXTURE_MARKER))).toBe(true);
    expect(rows!.some((r) => r.displayName === 'A Real Person')).toBe(false);
  });

  it('keeps a failed read a failed read', () => {
    // Fixtures make evidence safe. They must never make a broken screen look
    // like a working one — a capture of a substituted list on top of a failed
    // load would be evidence of nothing.
    enabled.mockReturnValue(true);
    expect(withCaptureFixtures(null, '')).toBeNull();
  });

  it('applies the query to the fixtures too', () => {
    enabled.mockReturnValue(true);
    // Three rows for one name: a WhatsApp entry, a typed entry carrying the
    // same number, and an Instagram entry that shares neither.
    expect(withCaptureFixtures(real, 'Avery')).toHaveLength(3);
    expect(withCaptureFixtures(real, 'Zzyzx')).toHaveLength(0);
  });

  it('shares a personId only between rows that carry the same phone', () => {
    /*
     * The join the unifier actually makes. It used to be a WhatsApp row and
     * an Instagram row sharing a `personId` — the most illustrative case, and
     * the one case that CANNOT happen: the unifier matches on phone and
     * Instagram contacts have none, so that row could never receive it. The
     * fixture was assigning it by hand, and the evidence showed a collapse
     * directly beneath the screen's sentence saying it was impossible.
     */
    enabled.mockReturnValue(true);
    const rows = withCaptureFixtures(real, '')!;
    const shared = rows.filter((r) => r.personId === 'fixture-person-1');

    expect(shared).toHaveLength(2);
    // The property that makes it reachable, asserted rather than assumed.
    expect(new Set(shared.map((r) => r.phone)).size).toBe(1);
    expect(shared.every((r) => r.phone !== null)).toBe(true);
  });

  it('never gives a personId to a row the unifier could not match', () => {
    // THE RULE THIS FILE BROKE ONCE: every fixture row must be a row the
    // product could have created. A contact with no phone cannot be joined
    // to anything, so it must not arrive pre-joined.
    enabled.mockReturnValue(true);
    for (const row of withCaptureFixtures(real, '')!) {
      if (row.phone === null) expect(row.personId, row.id).toBeNull();
    }
  });

  it('keeps an Instagram row that stands alone under the same name', () => {
    // The duplicate the screen's sentence describes — shown, not asserted.
    enabled.mockReturnValue(true);
    const rows = withCaptureFixtures(real, '')!;
    const instagram = rows.find((r) => r.channel === 'INSTAGRAM')!;
    expect(instagram.personId).toBeNull();
    expect(instagram.phone).toBeNull();
    expect(rows.filter((r) => r.displayName === instagram.displayName).length).toBeGreaterThan(1);
  });

  it('uses only reserved identifiers that can never belong to anyone', () => {
    enabled.mockReturnValue(true);
    for (const row of withCaptureFixtures(real, '')!) {
      if (row.email) expect(row.email).toMatch(/@example\.(com|org|net)$/);
      // Ofcom drama range, reserved for exactly this.
      if (row.phone) expect(row.phone).toMatch(/^\+447700900\d{3}$/);
    }
  });
});

describe('★★ withDetailFixtures — the gate that guards message bodies', () => {
  const real: CustomerDetail = {
    timeline: {
      contact: {
        id: 'real-1',
        displayName: 'A Real Person',
        externalId: '+972500000000',
        channel: 'WHATSAPP',
      },
      events: [
        {
          type: 'message',
          channel: 'WHATSAPP',
          conversationId: 'real-conv',
          direction: 'INBOUND',
          body: 'something a real customer actually wrote',
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      ],
    },
    brief: null,
    memory: null,
    noConversations: false,
  };

  it('substitutes nothing when the gate is closed', () => {
    /*
     * ★ THE DIRECTION THAT MATTERS ON A SCREEN LIKE THIS ONE is the other
     * one — a fixture leaking into production would be a screen showing a
     * merchant somebody else's customer. But this assertion is what proves
     * the gate is consulted at all, and it is the cheaper of the two to get
     * silently wrong.
     */
    enabled.mockReturnValue(false);
    expect(withDetailFixtures(real)).toBe(real);
  });

  it('★ substitutes EVERY field when the gate is open, never a mixture', () => {
    /*
     * Whole-object substitution, deliberately. A half-substituted page would
     * put a fixture name above a real person's messages, which is worse than
     * either alone — and it is exactly what per-field substitution drifts
     * into as fields are added.
     */
    enabled.mockReturnValue(true);
    const shown = withDetailFixtures(real);
    expect(shown.timeline?.contact?.displayName).toBe('Avery Stone');
    expect(JSON.stringify(shown)).not.toContain('a real customer actually wrote');
    expect(JSON.stringify(shown)).not.toContain('+972500000000');
  });

  it('★★ a failed read stays a failed read', () => {
    /*
     * Fixtures make evidence safe; they must never make a broken screen look
     * like a working one. A capture that substituted a healthy page over a
     * failed timeline would photograph proof of something that did not
     * happen — which is the one thing acceptance evidence cannot do.
     */
    enabled.mockReturnValue(true);
    const failed: CustomerDetail = {
      timeline: null,
      brief: null,
      memory: null,
      noConversations: false,
    };
    expect(withDetailFixtures(failed)).toBe(failed);
  });

  it('carries the marker the capture asserts before photographing', () => {
    // The spec checks a fixture is actually in place before it shoots, so a
    // run with the gate misconfigured cannot quietly bank real data.
    enabled.mockReturnValue(true);
    const shown = withDetailFixtures(real);
    expect(shown.timeline?.contact?.externalId).toBe('+447700900123');
  });
});
