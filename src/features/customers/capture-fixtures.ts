import 'server-only';

import type { CustomerDetail } from '@/features/customers/load-customer';
import type { CustomerRow } from '@/api/contracts/customers';
import { captureFixturesEnabled } from '@/features/security/capture-fixtures';

/**
 * Stand-in contacts, so acceptance evidence for screen 04 does not bank two
 * real people's names, phone numbers and email addresses into screenshots.
 *
 * ── WHY THIS SCREEN NEEDS IT MORE THAN SCREEN 16 DID ──
 * Screen 16 renders an IP address and a city. **This one renders a name, a
 * phone number and an email address on the same row** — directly identifying
 * and directly contactable, which the other was not. A full-page capture at
 * three viewports produces eighteen copies.
 *
 * ── THE GATE IS NOT A NEW ONE ──
 * `captureFixturesEnabled()` is imported unchanged from the security feature:
 * `E2E_SECURITY_FIXTURES=1` **and** an `APP_ORIGIN` on a loopback address,
 * failing closed on anything it cannot parse. One mechanism on two screens
 * beats two mechanisms that can drift — and that predicate has already been
 * wrong once, in the safe direction, silently. It is tested in both
 * directions and this file inherits that test rather than repeating it.
 *
 * ── WHY IT IS HERE AND NOT IN THE SPEC ──
 * Same reason as screen 16: the page is a server component, so the call
 * leaves the Node process and Playwright's `page.route` never sees it.
 *
 * ── WHY IT IS NOT A MOCK API LAYER ──
 * It substitutes one array, in one file, on one screen, only under that gate.
 * The count, the search, the collapsing and the rendering path are all the
 * live ones; no component knows this file exists. The list is still read from
 * the real endpoint and then replaced wholesale, so a broken loader still
 * fails the capture rather than being papered over.
 *
 * ── THE VALUES ──
 * `example.com` and `example.org` are RFC 2606 reserved domains and can never
 * belong to anyone. The numbers are in the UK RFC 5733 / Ofcom drama range
 * (`+44 7700 900xxx`), reserved for exactly this. They are deliberately
 * **distinct from each other in every field**, because a list whose rows were
 * identical would pass a capture that proved nothing about telling two people
 * apart.
 *
 * ── EVERY ROW MUST BE A ROW THE PRODUCT COULD HAVE CREATED ──
 * **If you cannot name the code path that would produce it, it does not go in
 * the evidence.** A fixture stands in for real data and inherits the same
 * obligation: it may hide who someone is, it may **not** manufacture an
 * outcome the code cannot reach.
 *
 * This file broke that rule once and it is worth keeping the example. The
 * first two rows used to be a WhatsApp contact and an Instagram contact
 * sharing a `personId`, with a comment explaining that this was *"what makes
 * the collapse visible in evidence"*. It was chosen because it was the most
 * illustrative case — and it is the one case that **cannot happen**: the
 * unifier matches on phone, Instagram contacts have `phone: null`, so that
 * row can never receive that `personId`. The fixture was assigning it by
 * hand.
 *
 * The evidence therefore showed a collapsed WhatsApp-plus-Instagram person
 * directly beneath the screen's own sentence saying that join is impossible.
 * **Green, and demonstrating something the product cannot do.**
 *
 * ── SO THE SHARED `personId` IS THE JOIN THAT ACTUALLY EXISTS ──
 * Two entries carrying the **same phone number**: one that arrived over
 * WhatsApp and one a person typed in. That is what the unifier produces, and
 * it is worth showing.
 *
 * The Instagram row then stands alone, under the same name — which is the
 * duplicate the screen's sentence describes. A reader sees both halves at
 * once: the join that works, and the one that does not.
 */
const FIXTURE_CONTACTS: readonly CustomerRow[] = [
  {
    id: 'fixture-1',
    externalId: '+447700900123',
    displayName: 'Avery Stone',
    channel: 'WHATSAPP',
    phone: '+447700900123',
    email: 'avery@example.com',
    tags: ['wholesale'],
    lastInteractionAt: null,
    source: null,
    /*
     * Shares a `personId` with the entry below because they carry the SAME
     * PHONE NUMBER. That is the join the unifier actually makes — and the
     * reason it is safe is that nothing customer-typed can reach
     * `Contact.phone`, so phone matching cannot merge two strangers.
     */
    personId: 'fixture-person-1',
    mergedIntoId: null,
  },
  {
    id: 'fixture-2',
    externalId: 'avery@example.com',
    displayName: 'Avery Stone',
    // Entered by a person rather than arriving over a channel — the second
    // half of the only join this product performs.
    channel: 'EMAIL',
    phone: '+447700900123',
    email: 'avery@example.com',
    tags: [],
    lastInteractionAt: null,
    source: null,
    personId: 'fixture-person-1',
    mergedIntoId: null,
  },
  {
    id: 'fixture-3',
    externalId: 'ig-averystone',
    displayName: 'Avery Stone',
    channel: 'INSTAGRAM',
    /*
     * `phone: null`, and that is the whole point. Instagram's `externalId` is
     * an opaque page-scoped id, so this row carries no identifier the unifier
     * can match on and **`personId` stays null forever**.
     *
     * Same name as the rows above, so the evidence shows the duplicate the
     * screen's sentence describes rather than merely asserting it.
     */
    phone: null,
    email: null,
    tags: [],
    lastInteractionAt: null,
    source: null,
    personId: null,
    mergedIntoId: null,
  },
  {
    id: 'fixture-4',
    externalId: 'rowan@example.org',
    displayName: 'Rowan Pike',
    channel: 'EMAIL',
    phone: null,
    email: 'rowan@example.org',
    tags: [],
    lastInteractionAt: null,
    source: null,
    // No personId: not known to be the same human as anyone else, which is a
    // different fact from being alone.
    personId: null,
    mergedIntoId: null,
  },
];

/** A string the capture asserts before it photographs anything. */
export const FIXTURE_MARKER = 'example.com';

/**
 * Substitutes the list when the gate allows it, and only then.
 *
 * Applied to what the real loader returned, so a failed read stays a failed
 * read: fixtures make evidence safe, they must never make a broken screen
 * look like a working one.
 */
export function withCaptureFixtures(
  rows: readonly CustomerRow[] | null,
  query: string,
): readonly CustomerRow[] | null {
  if (rows === null || !captureFixturesEnabled()) return rows;

  const q = query.trim().toLowerCase();
  if (!q) return FIXTURE_CONTACTS;

  /*
   * Search is applied to the fixtures too, so the capture of a no-match query
   * exercises the real empty state rather than a contrived one — and so a
   * fixture run cannot accidentally show rows for a query that matches none.
   */
  return FIXTURE_CONTACTS.filter((row) =>
    [row.displayName, row.phone, row.email].some((value) => value?.toLowerCase().includes(q)),
  );
}

/* ── Screen 04b, and it needs this MORE than the list does ──────────────── */

/**
 * The detail page's stand-in person.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ 04b EXPOSES FAR MORE THAN THE LIST, AND THE LIST ALREADY NEEDED A GATE
 * ════════════════════════════════════════════════════════════════════════════
 * The list renders a name, a phone number and an email address per row, and
 * that was enough to justify substituting it. This screen renders:
 *
 *   · the BODIES of a real person's messages, both directions
 *   · a written character study of them, generated by a model
 *   · durable facts GOTCHA has learned about them
 *
 * A full-page capture at three viewports banks eighteen copies of somebody's
 * actual conversation into a repository. That is a different order of
 * exposure from a phone number, and nothing about the fixture mechanism
 * covered it until now — `loadCustomer` had no gate at all.
 *
 * ── THE SAME GATE, NOT A SECOND ONE ──
 * `captureFixturesEnabled()` again, unchanged: `E2E_SECURITY_FIXTURES=1` AND
 * a loopback `APP_ORIGIN`, failing closed on anything it cannot parse. One
 * predicate on three screens beats three that can drift.
 *
 * ── AND IT MUST NOT HIDE A BROKEN SCREEN ──
 * Applied to what the real loader returned. A failed timeline stays a failed
 * timeline, so the capture of an unreachable customer photographs the real
 * error rather than a fixture standing in for it.
 */
const FIXTURE_DETAIL: CustomerDetail = {
  timeline: {
    contact: {
      id: 'fixture-1',
      displayName: 'Avery Stone',
      externalId: '+447700900123',
      channel: 'WHATSAPP',
    },
    events: [
      {
        type: 'message',
        channel: 'WHATSAPP',
        conversationId: 'fixture-conv-1',
        direction: 'INBOUND',
        body: 'Hi — is the wholesale order still arriving Thursday?',
        createdAt: '2026-09-18T09:14:00.000Z',
      },
      {
        type: 'message',
        channel: 'WHATSAPP',
        conversationId: 'fixture-conv-1',
        direction: 'OUTBOUND',
        body: 'It is, and I will send the tracking as soon as it ships.',
        createdAt: '2026-09-18T09:16:00.000Z',
      },
      {
        type: 'message',
        channel: 'EMAIL',
        conversationId: 'fixture-conv-2',
        direction: 'INBOUND',
        body: 'Following up on the March delivery — has anything changed?',
        createdAt: '2026-08-02T15:40:00.000Z',
      },
    ],
  },
  brief: {
    ok: true,
    summary:
      'Buys wholesale, roughly monthly, and almost always asks about delivery timing before anything else. Had a delayed shipment in March that took two messages to resolve; has been straightforward since. Writes briefly and expects the same back.',
    signals: ['Asks about delivery timing first', 'Delayed shipment in March, resolved'],
    generated_at: '2026-09-18T09:20:00.000Z',
    cached: true,
    meta: {
      conversation_count: 2,
      channels: ['WHATSAPP', 'EMAIL'],
      tone: 'brief and direct',
      mood: 'settled',
      recommended_behaviors: ['Lead with the delivery date'],
    },
  },
  memory: {
    context: {
      summary: null,
      facts: [
        { text: 'Buys wholesale rather than retail.', category: 'commercial', confidence: 'high' },
        {
          text: 'Experienced a delayed shipment in March 2026.',
          category: 'service',
          confidence: 'high',
        },
      ],
      messageCount: 412,
      source: 'historical_whatsapp_import',
      learnedAt: '2026-09-14T00:00:00.000Z',
    },
  },
  noConversations: false,
};

/**
 * Substitutes the whole detail when the gate allows it, and only then.
 *
 * Whole rather than per-field: a half-substituted page would put a fixture
 * name above a real person's messages, which is worse than either.
 */
export function withDetailFixtures(detail: CustomerDetail): CustomerDetail {
  if (!captureFixturesEnabled()) return detail;
  // A failed read stays a failed read. Fixtures make evidence safe; they must
  // never make a broken screen look like a working one.
  if (detail.timeline === null) return detail;
  return FIXTURE_DETAIL;
}
