import 'server-only';

import { businessPoliciesSchema } from '@/api/contracts/business-policies';
import { commerceContextSchema } from '@/api/contracts/customer-orders';
import type { CustomerDetail } from '@/features/customers/load-customer';
import type { CustomerRow } from '@/api/contracts/customers';
import { captureFixturesEnabled } from '@/features/security/capture-fixtures';

/**
 * Stand-in contacts, so acceptance evidence for screen 04 does not bank two
 * real people's names, phone numbers and email addresses into screenshots.
 *
 * ── WHY THIS SCREEN NEEDS IT MORE THAN SCREEN 16 DID ──
 * Screen 16 renders an IP address and a city. **This one renders a name, a
 * phone number and an email address on the same row** - directly identifying
 * and directly contactable, which the other was not. A full-page capture at
 * three viewports produces eighteen copies.
 *
 * ── THE GATE IS NOT A NEW ONE ──
 * `captureFixturesEnabled()` is imported unchanged from the security feature:
 * `E2E_SECURITY_FIXTURES=1` **and** an `APP_ORIGIN` on a loopback address,
 * failing closed on anything it cannot parse. One mechanism on two screens
 * beats two mechanisms that can drift - and that predicate has already been
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
 * ★ THIS RULE IS NOT SPECIFIC TO CAPTURES AND IT WAS WRONGLY SCOPED HERE.
 * It now lives in `api/contracts/README.md` because a UNIT fixture makes the
 * identical claim - `outreach.test.ts` carried `readCount: 904` on a counter
 * nothing increments, one directory over, for as long as anybody kept it.
 * The version below is the capture-specific half.
 *
 * **If you cannot name the code path that would produce it, it does not go in
 * the evidence.** A fixture stands in for real data and inherits the same
 * obligation: it may hide who someone is, it may **not** manufacture an
 * outcome the code cannot reach.
 *
 * This file broke that rule once and it is worth keeping the example. The
 * first two rows used to be a WhatsApp contact and an Instagram contact
 * sharing a `personId`, with a comment explaining that this was *"what makes
 * the collapse visible in evidence"*. It was chosen because it was the most
 * illustrative case - and it is the one case that **cannot happen**: the
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
 * The Instagram row then stands alone, under the same name - which is the
 * duplicate the screen's sentence describes. A reader sees both halves at
 * once: the join that works, and the one that does not.
 */
const FIXTURE_CONTACTS: readonly CustomerRow[] = [
  {
    id: 'fixture-1',
    externalId: '+447700900123',
    displayName: 'Avery Stone',
    // What the segment route sends for this row (lib/contact-label.ts): its name.
    displayLabel: 'Avery Stone',
    channel: 'WHATSAPP',
    phone: '+447700900123',
    email: 'avery@example.com',
    tags: ['wholesale'],
    lastInteractionAt: null,
    source: null,
    /*
     * Shares a `personId` with the entry below because they carry the SAME
     * PHONE NUMBER. That is the join the unifier actually makes - and the
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
    displayLabel: 'Avery Stone',
    // Entered by a person rather than arriving over a channel - the second
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
    displayLabel: 'Avery Stone',
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
    displayLabel: 'Rowan Pike',
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
   * exercises the real empty state rather than a contrived one - and so a
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
 * covered it until now - `loadCustomer` had no gate at all.
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
/**
 * Exported so a unit test can render THIS through the real component and
 * assert what the capture spec asserts. The capture is run by somebody else
 * on a machine this session cannot reach; without that test, a fixture that
 * disagrees with the spec is discovered during their run rather than before
 * it - and the fixture's whole job is to be the thing photographed.
 */
export const FIXTURE_DETAIL: CustomerDetail = {
  timeline: {
    contact: {
      id: 'fixture-1',
      displayName: 'Avery Stone',
      externalId: '+447700900123',
      channel: 'WHATSAPP',
      createdAt: '2024-03-12T09:00:00.000Z',
    },
    /*
     * ★ THE JOIN THAT EXISTS, FROM THE ROUTE'S OWN PROJECTION.
     *
     * The EMAIL entry shares this person's phone, which is what the unifier
     * matches on - `linked` rather than `merged` because it is a live
     * sibling contact rather than an alias left by a merge.
     *
     * No Instagram row: that contact has `phone: null`, so the unifier
     * cannot match it and it is never joined. Adding one would be the
     * WhatsApp-plus-Instagram mistake this file already records.
     */
    identityChannels: [
      {
        contactId: 'fixture-1',
        channel: 'WHATSAPP',
        externalId: '+447700900123',
        displayName: 'Avery Stone',
        source: 'linked',
      },
      {
        contactId: 'fixture-2',
        channel: 'EMAIL',
        externalId: 'avery@example.com',
        displayName: 'Avery Stone',
        source: 'linked',
      },
    ],
    events: [
      {
        type: 'message',
        channel: 'WHATSAPP',
        conversationId: 'fixture-conv-1',
        direction: 'INBOUND',
        body: 'Hi - is the wholesale order still arriving Thursday?',
        createdAt: '2026-09-18T09:14:00.000Z',
        origin: 'LIVE',
        id: 'fx-1',
        handover: null,
        action: null,
      },
      {
        type: 'message',
        channel: 'WHATSAPP',
        conversationId: 'fixture-conv-1',
        direction: 'OUTBOUND',
        body: 'It is, and I will send the tracking as soon as it ships.',
        createdAt: '2026-09-18T09:16:00.000Z',
        origin: 'LIVE',
        id: 'fx-2',
        handover: null,
        action: null,
      },
      {
        type: 'message',
        channel: 'EMAIL',
        conversationId: 'fixture-conv-2',
        direction: 'INBOUND',
        body: 'Following up on the March delivery - has anything changed?',
        createdAt: '2026-08-02T15:40:00.000Z',
        // Imported, so the capture photographs the label. Until today these
        // were excluded from the timeline entirely.
        origin: 'HISTORICAL_IMPORT',
        id: 'fx-3',
        handover: null,
        action: null,
      },
      /*
       * One of each remaining kind, so the capture photographs them rendering
       * from `handover` and `action` rather than from `body` - which is null
       * on both, and which the legacy screen shows as "(no body)".
       */
      {
        type: 'handover',
        channel: 'WHATSAPP',
        conversationId: 'fixture-conv-1',
        direction: null,
        body: null,
        createdAt: '2026-09-18T09:15:00.000Z',
        origin: 'LIVE',
        id: 'fx-4',
        handover: {
          from: 'ai',
          to: 'Dana',
          actorUserId: 'fixture-user',
          reason: 'wholesale pricing',
        },
        action: null,
      },
      {
        type: 'ai_action',
        channel: 'WHATSAPP',
        conversationId: 'fixture-conv-1',
        direction: null,
        body: null,
        createdAt: '2026-09-18T09:15:30.000Z',
        origin: 'LIVE',
        id: 'fx-5',
        handover: null,
        action: {
          tool: 'shopify.get_customer_orders',
          success: true,
          status: 'completed',
          labelKey: 'looking_up_order',
          triggeredBy: 'ai',
          durationMs: 412,
          approvedBy: null,
        },
      },
    ],
    page: {
      limit: 50,
      types: ['message', 'handover', 'ai_action'],
      nextCursor: null,
      hasMore: true,
    },
    /*
     * The real coverage map, copied from `identity.ts:315-327`, because the
     * capture has to photograph the caveats a merchant actually sees.
     *
     * ★ `ai_action` is AVAILABLE and carries a detail. That is the entry a
     * screen is most likely to skip - `available: true` reads as "fine" -
     * and it is the one saying a Shopify refund the AI performed is not in
     * this list. An empty coverage map here would have produced a shot with
     * no caveats at all and a passing spec.
     */
    coverage: {
      message: { available: true, reason: null, detail: null },
      handover: { available: true, reason: null, detail: null },
      ai_action: {
        available: true,
        reason: null,
        detail:
          'ToolExecution records catalog HTTP tools only. An action taken through an adapter, such as a Shopify refund, is not recorded here.',
      },
      order: {
        available: false,
        reason: 'no_local_model',
        detail: 'Orders live in the commerce platform and are served by their own screen.',
      },
      return: {
        available: false,
        reason: 'no_local_model',
        detail: 'Returns live in the commerce platform and are served by their own screen.',
      },
      note: {
        available: false,
        reason: 'external_crm',
        detail: "Notes are written to the merchant's CRM and read back as recent_crm_notes.",
      },
    },
    /*
     * More than is shown, deliberately: the capture should photograph the
     * "50 of 1,284" sentence rather than the all-of-it one, because the
     * partial case is the one that used to be told as a lie.
     */
    totals: {
      conversations: 2,
      messages: 1284,
      handovers: 6,
      aiActions: 31,
      conversationScanTruncated: false,
    },
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
      reason: null,
    },
  },
  memory: {
    context: {
      summary: null,
      facts: [
        {
          text: 'Buys wholesale rather than retail.',
          category: 'commercial',
          confidence: 'high',
          evidenceConversationIds: ['fixture-conv-1'],
        },
        {
          text: 'Experienced a delayed shipment in March 2026.',
          category: 'service',
          confidence: 'high',
          evidenceConversationIds: ['fixture-conv-2'],
        },
      ],
      messageCount: 412,
      source: 'historical_whatsapp_import',
      learnedAt: '2026-09-14T00:00:00.000Z',
      evidenceWindow: { from: '2026-03-02T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' },
    },
  },
  /*
   * A CRM that is connected and linked, with two notes - so the capture
   * photographs the state a merchant with a working CRM sees, rather than
   * one of the two blocked sentences. Those are unit-tested instead.
   */
  crm: {
    recent_crm_notes: [
      {
        id: 'fixture-note-1',
        kind: 'note',
        body: 'Prefers the Thursday delivery slot - confirmed twice.',
        occurred_at: '2026-09-10T08:00:00.000Z',
      },
      {
        id: 'fixture-note-2',
        kind: 'note',
        body: 'Asked to be told before any substitution.',
        occurred_at: '2026-06-21T12:30:00.000Z',
      },
    ],
    link_meta: { outcome: 'linked' },
  },
  /*
   * Screen 04d. The `ok` state with two orders - one troubled, so the
   * capture photographs the expansion rule choosing the RIGHT one rather
   * than simply the first.
   *
   * The chips carry the platform's own localised labels and tones, because
   * that is what the real response does and a fixture with invented labels
   * would photograph a screen nobody will ever see.
   */
  /*
   * ★★ WIRE-SHAPED, AND PARSED BY THE REAL CONTRACT.
   *
   * Amounts are decimal STRINGS, as `commerce-context.types.ts` sends them;
   * the milestones are the ones `buildTimeline` writes, in its order and
   * with its labels; `adminUrl` is `adminUrl()`'s shape. Parsing it here is
   * what makes the fixture a test of the contract: the number-typed
   * `amount` it replaced would have thrown on this object.
   */
  orders: commerceContextSchema.parse({
    state: 'ok',
    data: {
      provider: 'shopify',
      summary: {
        orderCount: 2,
        name: 'Avery Stone',
        currency: 'ILS',
        averageOrderValue: { amount: '300.00', currency: 'ILS' },
        customerSince: '2025-11-03T10:00:00.000Z',
        defaultAddress: 'Avery Stone, Herzl 12, Haifa, Israel',
        totalSpentByCurrency: [{ amount: '600.00', currency: 'ILS' }],
        shopCurrencyTotal: { amount: '600.00', currency: 'ILS' },
        lastOrderAt: '2026-09-16T11:02:00.000Z',
        repeatCustomer: true,
        openOrderCount: 1,
        refundedOrCancelledCount: 0,
      },
      fetchedAt: '2026-09-18T09:20:00.000Z',
      cacheTtlSeconds: 60,
      /*
       * ★ THE ID 04e's `supplied: ['shopifyCustomerId']` CLAIMS WE SENT.
       * `verified: true` is the only shape this can take: the service sets
       * it solely on the path that resolved the id from the trusted
       * conversation linkage, and anything else answers
       * `customer_not_linked` and loads nothing. A fixture with an
       * unverified id would describe a request the code would never make.
       */
      customer: { verified: true, customerId: 'fixture-shopify-customer-1' },
      recentOrders: [
        {
          orderId: 'fixture-order-1',
          orderNumber: '#1246',
          adminUrl: 'https://fixture-store.myshopify.com/admin/orders/fixture-order-1',
          createdAt: '2026-09-16T11:02:00.000Z',
          total: { amount: '420.00', currency: 'ILS' },
          financial: { key: 'paid', label: 'Paid', tone: 'positive' },
          fulfillment: { key: 'partial', label: 'Partially fulfilled', tone: 'warning' },
          cancelled: false,
          refund: null,
          shipping: { key: 'shipped', label: 'Shipped', tone: 'neutral' },
          items: [
            { title: 'Olive oil, 750ml', quantity: 6, imageUrl: null },
            { title: 'Sea salt, coarse', quantity: 2, imageUrl: null },
          ],
          extraItemCount: 3,
          refundedAmount: { amount: '0.00', currency: 'ILS' },
          refundableMaximum: { amount: '420.00', currency: 'ILS' },
          timeline: [
            { key: 'placed', label: 'Order placed', at: '2026-09-16T11:02:00.000Z', reached: true },
            {
              key: 'payment',
              label: 'Payment confirmed',
              at: '2026-09-16T11:03:00.000Z',
              reached: true,
            },
            { key: 'fulfilled', label: 'Fulfilled', at: '2026-09-17T08:40:00.000Z', reached: true },
            { key: 'shipped', label: 'Shipped', at: null, reached: true },
            { key: 'delivered', label: 'Delivered', at: null, reached: false },
          ],
          detail: {
            lineItems: [
              {
                lineItemId: 'li-1',
                title: 'Olive oil, 750ml',
                variantTitle: 'Early harvest',
                quantity: 6,
                unitPrice: { amount: '45.00', currency: 'ILS' },
                lineTotal: { amount: '270.00', currency: 'ILS' },
                imageUrl: null,
              },
              {
                lineItemId: 'li-2',
                title: 'Sea salt, coarse',
                quantity: 2,
                unitPrice: { amount: '25.00', currency: 'ILS' },
                lineTotal: { amount: '50.00', currency: 'ILS' },
                imageUrl: null,
              },
            ],
            itemCount: 11,
            tracking: [{ number: 'RR204917IL', company: 'Israel Post' }],
            shippingAddress: 'Avery Stone, Herzl 12, Haifa, Israel',
            tags: [],
            refunds: [],
          },
          eligibility: {
            cancellable: false,
            refundable: true,
            returnable: true,
            exchangeable: false,
          },
        },
        {
          orderId: 'fixture-order-2',
          orderNumber: '#1203',
          adminUrl: 'https://fixture-store.myshopify.com/admin/orders/fixture-order-2',
          createdAt: '2026-08-02T15:31:00.000Z',
          total: { amount: '180.00', currency: 'ILS' },
          financial: { key: 'paid', label: 'Paid', tone: 'positive' },
          fulfillment: { key: 'delivered', label: 'Delivered', tone: 'positive' },
          cancelled: false,
          refund: null,
          shipping: { key: 'delivered', label: 'Delivered', tone: 'positive' },
          items: [{ title: 'Olive oil, 750ml', quantity: 2, imageUrl: null }],
          extraItemCount: 0,
          refundedAmount: { amount: '0.00', currency: 'ILS' },
          refundableMaximum: { amount: '0.00', currency: 'ILS' },
          timeline: [
            { key: 'placed', label: 'Order placed', at: '2026-08-02T15:31:00.000Z', reached: true },
            {
              key: 'payment',
              label: 'Payment confirmed',
              at: '2026-08-02T15:31:00.000Z',
              reached: true,
            },
            { key: 'fulfilled', label: 'Fulfilled', at: '2026-08-03T09:00:00.000Z', reached: true },
            { key: 'shipped', label: 'Shipped', at: null, reached: true },
            { key: 'delivered', label: 'Delivered', at: null, reached: true },
          ],
          eligibility: {
            cancellable: false,
            refundable: false,
            returnable: false,
            exchangeable: false,
            reasonIfNot: 'This order was delivered more than 30 days ago.',
          },
        },
      ],
    },
  }),
  conversationId: 'fixture-conv-1',
  // What the insights route answers for these two: one still open, one closed.
  conversationStatus: new Map([
    ['fixture-conv-1', 'OPEN'],
    ['fixture-conv-2', 'CLOSED'],
  ]),
  noConversations: false,
  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ SCREEN 04f - THE FIRST CUSTOMER SCREEN WHOSE POPULATED STATE IS REAL
   * ════════════════════════════════════════════════════════════════════════
   * Every other section here stands in for data this tenant cannot produce.
   * Notes are different: the table is live and empty, so **the real empty
   * state is the honest screen** and these rows exist only to photograph the
   * variants a real tenant will have.
   *
   * ── EVERY ROW IS ONE THE ROUTE CAN WRITE ──
   * The four destinations below are the four the mirror actually produces
   * with a body it has: SYNCED, FAILED, and NOT_APPLICABLE by way of
   * `not_ai_usable` and `no_crm_link`. `authorName` is denormalised on the
   * real column, `editHistory` non-empty is what an edit leaves.
   *
   * ── AND `viewerUserId` MATCHES ONE AUTHOR, DELIBERATELY ──
   * So the evidence shows both halves of the authorship rule at once: the
   * note this reader may edit, and the teammate's note they may not. A
   * fixture where the viewer owned everything would photograph a screen that
   * cannot tell the two apart.
   */
  notes: [
    {
      id: 'fx-note-1',
      body: 'Prefers delivery after 4pm - asked twice. Worth remembering before we promise a morning slot.',
      visibility: 'TEAM',
      aiUsable: true,
      status: 'PUBLISHED',
      authorUserId: 'fixture-viewer-1',
      authorName: 'Dana Levi',
      conversationId: 'fixture-conv-1',
      editHistory: [],
      externalSystem: 'hubspot',
      externalSyncStatus: 'SYNCED',
      externalSyncError: null,
      externalSyncedAt: '2026-09-18T09:22:00.000Z',
      deletedAt: null,
      createdAt: '2026-09-18T09:21:00.000Z',
      updatedAt: '2026-09-18T09:22:00.000Z',
    },
    {
      /*
       * ★ NOT MARKED FOR THE AI, SO IT NEVER LEFT. The push is the only
       * chokepoint - once a note is in the CRM it returns through
       * `recent_crm_notes` into the brief and into the model, and no filter
       * on our own table can stop it. The screen says where it lives.
       */
      id: 'fx-note-2',
      body: 'Chased us about the invoice twice. Keep it in mind but do not let GOTCHA bring it up.',
      visibility: 'TEAM',
      aiUsable: false,
      status: 'PUBLISHED',
      authorUserId: 'fixture-viewer-1',
      authorName: 'Dana Levi',
      conversationId: 'fixture-conv-1',
      // Edited once: the screen says THAT it changed, never what it said.
      editHistory: [{ at: '2026-09-18T10:02:00.000Z' }],
      externalSystem: null,
      externalSyncStatus: 'NOT_APPLICABLE',
      externalSyncError: 'not_ai_usable',
      externalSyncedAt: null,
      deletedAt: null,
      createdAt: '2026-09-18T09:58:00.000Z',
      updatedAt: '2026-09-18T10:02:00.000Z',
    },
    {
      /*
       * ★★ A FAILED PUSH, SAID OUT LOUD. The lesson of the stub that
       * answered 200 and wrote nothing: a write reported as saved when it
       * was refused is worse than one that refuses.
       *
       * Written by somebody else, so this row also carries the half of the
       * authorship rule where the controls are absent.
       */
      id: 'fx-note-3',
      body: 'Agreed a 10% credit on the late order. Finance know.',
      visibility: 'TEAM',
      aiUsable: true,
      status: 'PUBLISHED',
      authorUserId: 'fixture-other-1',
      authorName: 'Noa Barak',
      conversationId: 'fixture-conv-1',
      editHistory: [],
      externalSystem: null,
      externalSyncStatus: 'FAILED',
      externalSyncError: 'rate_limited',
      externalSyncedAt: null,
      deletedAt: null,
      createdAt: '2026-09-17T14:05:00.000Z',
      updatedAt: '2026-09-17T14:05:00.000Z',
    },
    {
      /*
       * ★ A CRM IS CONNECTED AND THIS PERSON IS NOT IN IT. Distinct from "no
       * CRM connected", and telling this merchant to connect one would be
       * the mistake four other screens already record.
       */
      id: 'fx-note-4',
      body: 'Came in from the Instagram ad, not the shop.',
      visibility: 'TEAM',
      aiUsable: true,
      status: 'PUBLISHED',
      authorUserId: 'fixture-other-1',
      authorName: 'Noa Barak',
      conversationId: 'fixture-conv-1',
      editHistory: [],
      externalSystem: null,
      externalSyncStatus: 'NOT_APPLICABLE',
      externalSyncError: 'no_crm_link',
      externalSyncedAt: null,
      deletedAt: null,
      createdAt: '2026-09-16T08:30:00.000Z',
      updatedAt: '2026-09-16T08:30:00.000Z',
    },
  ],
  viewerUserId: 'fixture-viewer-1',
  approvals: [],
  /*
   * Wire-shaped - `{ actionKinds, policies }`, the latest version per kind -
   * and parsed by the real contract. A refund rule with both limits, a
   * cancel rule switched off; the other four kinds fall to the engine's
   * defaults, which is what most tenants will show.
   */
  policies: businessPoliciesSchema.parse({
    actionKinds: ['REFUND', 'CANCEL_ORDER', 'COUPON', 'COMPENSATION', 'DISCOUNT', 'CUSTOMER_WRITE'],
    policies: [
      {
        id: 'fx-policy-refund',
        actionKind: 'REFUND',
        enabled: true,
        version: 3,
        config: { maxAmount: 300, managerApprovalAboveAmount: 100 },
      },
      {
        id: 'fx-policy-cancel',
        actionKind: 'CANCEL_ORDER',
        enabled: false,
        version: 1,
        config: {},
      },
    ],
  }),
  // The fixture stands for a page where every read succeeded. A real page
  // that did not gets its failures carried through - see `keepFailures`.
  readsFailed: [],
  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ SCREEN 04e - AND EVERY ROW IS ONE THE PLATFORM ACTUALLY WRITES
   * ════════════════════════════════════════════════════════════════════════
   * Checked at the write sites, not taken from the route's header. The
   * header advertises `crm.link.linked` as part of the "rich set"; **no code
   * in the platform writes it**, so it is not here. The same mistake as the
   * WhatsApp-plus-Instagram row above, and caught the same way - by looking
   * for the code path rather than for a sentence describing one.
   *
   * ── WHAT IS DELIBERATELY ABSENT ──
   * **No `contradicts` row and no `nameImpliesSucceeded` hint.** Both need
   * an action carrying an `ok.`/`err.` segment whose recorded verdict
   * disagrees with it. The only writer of such an action is
   * `auditAdapterCall`, which sets the name and `metadata.ok` from the SAME
   * boolean - they cannot disagree. Manufacturing one would put a row in the
   * evidence that this platform cannot produce, which is the exact rule this
   * file exists to keep. Those branches are unit-tested and named unreached.
   *
   * ── AND `not_recorded` IS THE MAJORITY, WHICH IS REAL ──
   * `commerce.customer_action_executed` and `..._failed` write no
   * `metadata.ok`, so `succeeded` is null on every customer-keyed row. The
   * evidence shows an ordinary log where most outcomes were never written
   * down, because that is what this platform's log looks like.
   */
  actions: {
    state: 'ok',
    supplied: ['shopifyCustomerId'],
    audit: {
      contact: { id: 'fixture-1', displayName: 'Avery Stone' },
      data: [
        {
          // `logAudit` from `ai.service.ts`, metadata `{model, type, tokens}`
          // - no `ok`, so the outcome genuinely was never recorded.
          id: 'fx-audit-1',
          actorType: 'ai',
          actorId: null,
          action: 'ai.responded',
          labelKey: null,
          targetType: 'conversation',
          targetId: 'fixture-conv-1',
          createdAt: '2026-09-18T09:16:00.000Z',
          succeeded: null,
          nameImpliesSucceeded: null,
          outcomeDisagrees: false,
        },
        {
          // `auditAdapterCall` - the one writer that records a verdict, and
          // it records it in agreement with its own name, always.
          id: 'fx-audit-2',
          actorType: 'ai',
          actorId: null,
          action: 'adapter.ok.shopify.get_customer_orders',
          labelKey: 'looking_up_order',
          targetType: 'conversation',
          targetId: 'fixture-conv-1',
          createdAt: '2026-09-18T09:15:30.000Z',
          succeeded: true,
          nameImpliesSucceeded: true,
          outcomeDisagrees: false,
        },
        {
          id: 'fx-audit-3',
          actorType: 'ai',
          actorId: null,
          action: 'adapter.err.shopify.process_refund',
          labelKey: 'processing_refund',
          targetType: 'conversation',
          targetId: 'fixture-conv-1',
          createdAt: '2026-09-17T14:02:00.000Z',
          succeeded: false,
          nameImpliesSucceeded: false,
          outcomeDisagrees: false,
        },
        {
          /*
           * ★ THE ROW THE SCREEN IS HARDEST ON. Its name says it was done;
           * `commerce-actions.service.ts` writes no `metadata.ok` beside it,
           * so nothing recorded whether it was. The screen shows the name
           * and says the outcome is unrecorded - it does not let the name
           * decide, which is the defect Backend caught in `outcomeOf`.
           */
          id: 'fx-audit-4',
          actorType: 'user',
          actorId: 'fixture-agent-1',
          action: 'commerce.customer_action_executed',
          labelKey: null,
          targetType: 'customer',
          targetId: 'fixture-shopify-customer-1',
          createdAt: '2026-09-16T11:40:00.000Z',
          succeeded: null,
          nameImpliesSucceeded: null,
          outcomeDisagrees: false,
        },
      ],
      nextCursor: null,
      /*
       * ★ VERBATIM FROM `CUSTOMER_AUDIT_COVERAGE` in
       * `services/auth/src/routes/audit-logs.ts`. Copied rather than
       * paraphrased for the reason the chips are: a second, vaguer copy of a
       * sentence they already wrote would drift from it.
       *
       * `customer` still declares `requires: "shopifyCustomerId"` even
       * though this fixture SUPPLIED it - the constant is what the endpoint
       * returns either way. `supplied` above is what stops the screen
       * printing "pass it" underneath the rows it fetched.
       */
      coverage: {
        conversation: { attributable: true, requires: null, reason: null, detail: null },
        customer: {
          attributable: true,
          requires: 'shopifyCustomerId',
          reason: null,
          detail:
            "Rows are keyed by the commerce platform's customer id, which this endpoint cannot " +
            'derive from a contact. Pass ?shopifyCustomerId= to include them.',
        },
        order: {
          attributable: false,
          requires: null,
          reason: 'no_local_order_table',
          detail:
            "Order-keyed rows are keyed by the commerce platform's order id and there is no " +
            "local Order table to enumerate this person's orders from.",
        },
      },
      scope: { identities: 2, conversations: 1, conversationScanTruncated: false },
    },
  },
};

/**
 * Substitutes the whole detail when the gate allows it, and only then.
 *
 * Whole rather than per-field: a half-substituted page would put a fixture
 * name above a real person's messages, which is worse than either.
 */
/**
 * The ids the fixture LIST serves. A detail page can only be opened with one
 * of these while the gate is on, because they are the only rows on screen.
 */
const FIXTURE_CONTACT_IDS: ReadonlySet<string> = new Set(FIXTURE_CONTACTS.map((c) => c.id));

/**
 * Substitutes the whole detail when the gate allows it, and only then.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY THIS TAKES THE ID, AND WHY IT SUBSTITUTES OVER A FAILED READ
 * ════════════════════════════════════════════════════════════════════════════
 * The first version refused to substitute whenever `timeline === null`, on
 * the rule that a failed read must stay a failed read - fixtures make
 * evidence safe, they must never make a broken screen look like a working
 * one. That rule is right and it made this screen **unphotographable.**
 *
 * The fixture LIST serves synthetic ids. Opening one calls the real timeline
 * endpoint with an id no tenant has, which 404s - so under the gate every
 * customer page rendered "we couldn't load this customer", and the capture
 * would have banked a shot of an error state as evidence for 04b.
 *
 * A 404 for an id WE INVENTED is not the screen failing. It is the expected
 * answer to a question about somebody who does not exist.
 *
 * So the two cases are separated by the id:
 *
 *   fixture id + gate open   substitute, even over a failed read - the read
 *                            was always going to fail and its failure says
 *                            nothing about the screen
 *   real id    + gate open   a failure stays a failure. THIS is the case the
 *                            original rule was protecting, and it is intact:
 *                            a real customer whose page is broken must never
 *                            be photographed as healthy
 *   gate closed              nothing is ever substituted
 *
 * Found by writing the capture spec rather than by running it - the screen
 * was built, unit-tested and committed in a state where no shot of it could
 * ever have been taken.
 */
export function withDetailFixtures(detail: CustomerDetail, contactId: string): CustomerDetail {
  if (!captureFixturesEnabled()) return detail;
  if (FIXTURE_CONTACT_IDS.has(contactId)) return FIXTURE_DETAIL;
  // A real person's page. If it is broken, it is photographed broken.
  if (detail.timeline === null) return detail;
  return keepFailures(detail);
}

/**
 * Substitute the CONTENT, keep the FAILURES.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE GUARD ABOVE WAS WRITTEN WHEN THE TIMELINE WAS THE ONLY READ THAT
 *    COULD FAIL, AND IT SILENTLY STOPPED BEING ENOUGH
 * ════════════════════════════════════════════════════════════════════════════
 * On 2026-09-25 the 04e audit read failed on every capture run - our
 * contract and the response envelope disagreeing - and `customer-actions`
 * photographed a healthy panel at three viewports in two locales. The
 * spec's tripwire for precisely that state never fired, because by the time
 * the page rendered, this function had already replaced the failed read
 * with a fixture whose state is `ok`.
 *
 * **84 assertions agreed with the screen, and the screen was a fixture
 * standing over a read that returned nothing.** Which is the one thing this
 * file's own header says it must never do.
 *
 * The rule was right and the implementation checked a single read by name.
 * A guard written against the failures that existed when it was written
 * does not cover the failure added afterwards - and nothing reports the
 * gap, because the guard still passes.
 *
 * ── WHY THIS IS SAFE FOR THE THING FIXTURES EXIST FOR ──
 * A failed read carries NO DATA. Preserving it leaks nothing: the page
 * shows the fixture's name above a sentence saying we could not read that
 * section, which is exactly what a merchant would see and exactly what the
 * evidence should show.
 *
 * ── AND WHY IT TAKES A LIST RATHER THAN CHECKING FOR `null` ──
 * `brief`, `memory`, `crm` and `orders` are `null` both when the read
 * failed and when it was never attempted. Reading `null` as failure would
 * report failures that never happened on every customer with no
 * conversation. `readsFailed` is recorded at the catch, where the loader
 * still knows which it was.
 */
function keepFailures(detail: CustomerDetail): CustomerDetail {
  if (detail.readsFailed.length === 0) return FIXTURE_DETAIL;
  const failed = new Set(detail.readsFailed);
  return {
    ...FIXTURE_DETAIL,
    ...(failed.has('brief') ? { brief: null } : {}),
    ...(failed.has('memory') ? { memory: null } : {}),
    ...(failed.has('crm') ? { crm: null } : {}),
    ...(failed.has('orders') ? { orders: null } : {}),
    ...(failed.has('actions') ? { actions: detail.actions } : {}),
    ...(failed.has('notes') ? { notes: null } : {}),
    ...(failed.has('approvals') ? { approvals: null } : {}),
    ...(failed.has('policies') ? { policies: null } : {}),
    ...(failed.has('viewer') ? { viewerUserId: null } : {}),
    readsFailed: detail.readsFailed,
  };
}
