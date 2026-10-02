import { describe, expect, it, vi } from 'vitest';

import type { CustomerRow } from '@/api/contracts/customers';

import type { CustomerDetail } from './load-customer';

import {
  FIXTURE_DETAIL,
  FIXTURE_MARKER,
  withCaptureFixtures,
  withDetailFixtures,
} from './capture-fixtures';

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
      identityChannels: [],
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
          origin: 'LIVE',
          id: 'fx-1',
          handover: null,
          action: null,
        },
      ],
      page: { limit: 50, types: ['message'], nextCursor: null, hasMore: false },
      coverage: {},
      totals: {
        conversations: 1,
        messages: 1,
        handovers: 0,
        aiActions: 0,
        conversationScanTruncated: false,
      },
    },
    brief: null,
    memory: null,
    crm: null,
    orders: null,
    conversationId: null,
    noConversations: false,
    // A real person's page whose audit log we could not read.
    actions: { state: 'failed' },
    notes: null,
    approvals: null,
    policies: null,
    viewerUserId: null,
    readsFailed: ['actions'],
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
    expect(withDetailFixtures(real, 'fixture-1')).toBe(real);
  });

  it('★ substitutes EVERY field when the gate is open, never a mixture', () => {
    /*
     * Whole-object substitution, deliberately. A half-substituted page would
     * put a fixture name above a real person's messages, which is worse than
     * either alone — and it is exactly what per-field substitution drifts
     * into as fields are added.
     */
    enabled.mockReturnValue(true);
    const shown = withDetailFixtures(real, 'fixture-1');
    expect(shown.timeline?.contact?.displayName).toBe('Avery Stone');
    expect(JSON.stringify(shown)).not.toContain('a real customer actually wrote');
    expect(JSON.stringify(shown)).not.toContain('+972500000000');
  });

  it("★★ a REAL person's failed page is photographed broken", () => {
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
      crm: null,
      orders: null,
      conversationId: null,
      noConversations: false,
      // The timeline failed, so 04e was never asked for.
      actions: { state: 'not_asked' },
      notes: null,
      approvals: null,
      policies: null,
      viewerUserId: null,
      readsFailed: [],
    };
    expect(withDetailFixtures(failed, 'real-contact-99')).toBe(failed);
  });

  it('★★ but a FIXTURE id substitutes even over a failed read', () => {
    /*
     * The fixture list serves synthetic ids. Opening one calls the real
     * timeline endpoint with an id no tenant has, which 404s — so the first
     * version of this function, which refused to substitute over any failed
     * read, made the whole screen **unphotographable**: every customer page
     * under the gate rendered "we couldn't load this customer".
     *
     * A 404 for an id WE INVENTED is not the screen failing; it is the
     * expected answer about somebody who does not exist. The rule that
     * matters — a real person's broken page is never photographed healthy —
     * is the test above, and it is intact.
     *
     * Found by writing the capture spec, not by running it. The screen was
     * built, unit-tested and committed in a state where no shot of it could
     * have been taken.
     */
    enabled.mockReturnValue(true);
    const failed: CustomerDetail = {
      timeline: null,
      brief: null,
      memory: null,
      crm: null,
      orders: null,
      conversationId: null,
      noConversations: false,
      // The timeline failed, so 04e was never asked for.
      actions: { state: 'not_asked' },
      notes: null,
      approvals: null,
      policies: null,
      viewerUserId: null,
      readsFailed: [],
    };
    const shown = withDetailFixtures(failed, 'fixture-1');
    expect(shown.timeline).not.toBeNull();
    expect(shown.timeline?.contact?.displayName).toBe('Avery Stone');
  });

  it('substitutes nothing for a fixture id when the gate is closed', () => {
    // The id is not an escape hatch — the gate still decides.
    enabled.mockReturnValue(false);
    expect(withDetailFixtures(real, 'fixture-1')).toBe(real);
  });

  it('carries the marker the capture asserts before photographing', () => {
    // The spec checks a fixture is actually in place before it shoots, so a
    // run with the gate misconfigured cannot quietly bank real data.
    enabled.mockReturnValue(true);
    const shown = withDetailFixtures(real, 'fixture-1');
    expect(shown.timeline?.contact?.externalId).toBe('+447700900123');
  });
});

describe('★★ the fixture substitutes CONTENT and must never substitute HEALTH', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * THE DEFECT THIS GUARDS, WHICH SHIPPED AND PASSED 84 ASSERTIONS
   * ══════════════════════════════════════════════════════════════════════════
   * The 04e audit read failed on all six capture runs — our contract and the
   * response envelope disagreeing — and the capture photographed a healthy
   * panel at three viewports in two locales. The spec's own tripwire for
   * that exact state (`customer-actions-failed` must not appear) could not
   * fire: `withDetailFixtures` had already replaced the failed read with a
   * fixture whose state is `ok`.
   *
   * The guard it slipped past checks `timeline === null`, which was every
   * read that could fail on the day it was written. It stopped being enough
   * the moment a sibling read was added, and nothing said so, because the
   * guard still passed.
   */
  const realDetail = (over: Partial<CustomerDetail>): CustomerDetail => ({
    ...FIXTURE_DETAIL,
    ...over,
  });

  it('★★ carries a FAILED sibling read through, rather than hiding it', () => {
    enabled.mockReturnValue(true);
    const out = withDetailFixtures(
      realDetail({ actions: { state: 'failed' }, readsFailed: ['actions'] }),
      'a-real-contact-id',
    );

    // The failure survives — so the screen renders its failure panel and the
    // capture spec's tripwire gets the chance it was written to have.
    expect(out.actions.state).toBe('failed');
    // And the substitution still did its job: no real person's name or
    // message bodies are on the page.
    expect(out.timeline?.contact?.displayName).toBe('Avery Stone');
  });

  it('★ carries a failed orders read through too — this is a CLASS, not a case', () => {
    /*
     * Fixing only the read that happened to break is the mistake this
     * project has made before. Every sibling read can fail the same way.
     */
    enabled.mockReturnValue(true);
    const out = withDetailFixtures(
      realDetail({ orders: null, readsFailed: ['orders'] }),
      'a-real-contact-id',
    );
    expect(out.orders).toBeNull();
    expect(out.brief).not.toBeNull();
  });

  it('★★ does NOT invent a failure from a read that was never attempted', () => {
    /*
     * `brief`, `memory`, `crm` and `orders` are null both when the read
     * failed and when there was nothing to ask with — no conversation, no
     * external id. Reading null as failure would report a broken section on
     * every customer who has never written.
     *
     * Which is why `readsFailed` is recorded at the catch and not derived
     * here: this function cannot tell, and guessing would be the same
     * unknown-collapsed-into-a-verdict the whole screen is built against.
     */
    enabled.mockReturnValue(true);
    const out = withDetailFixtures(
      realDetail({ crm: null, orders: null, readsFailed: [] }),
      'a-real-contact-id',
    );
    expect(out.crm).not.toBeNull();
    expect(out.orders).not.toBeNull();
  });

  it('substitutes wholesale for a fixture id, whose reads 404 by construction', () => {
    // Unchanged and still right: a 404 for an id we invented says nothing
    // about the screen, so its failure is not preserved.
    enabled.mockReturnValue(true);
    const out = withDetailFixtures(
      realDetail({ actions: { state: 'failed' }, readsFailed: ['actions'] }),
      'fixture-1',
    );
    expect(out.actions.state).toBe('ok');
  });
});
