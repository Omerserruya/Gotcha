import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  briefSchema,
  crmContextSchema,
  memorySchema,
  timelineSchema,
  type CustomerBrief,
  type CrmContext,
  type CustomerMemory,
  type CustomerTimeline,
} from '@/api/contracts/customer-detail';
import {
  commerceContextSchema,
  shopifyCustomerIdIn,
  type CommerceContextResponse,
} from '@/api/contracts/customer-orders';
import { customerAuditSchema, type CustomerAudit } from '@/api/contracts/customer-actions';
import { noteListSchema, type Note } from '@/api/contracts/customer-notes';
import { currentUserSchema } from '@/api/contracts/identity';
import { APPROVAL_STATUSES, approvalsSchema, type Approval } from '@/api/contracts/approvals';
import { approvalEndpoints, authEndpoints } from '@/api/endpoints/registry';
import { ApiError } from '@/api/client/api-error';
import { customerEndpoints } from '@/api/endpoints/registry';
import { withDetailFixtures } from './capture-fixtures';
import { readKeyFor } from './conversation-key';
import { logger } from '@/observability/logger';

/**
 * What screen 04b reads.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ORDERED, NOT PARALLEL — AND THAT IS THE DATA'S FAULT, NOT A PREFERENCE
 * ════════════════════════════════════════════════════════════════════════════
 * Three reads describing one person, each keyed differently:
 *
 *   timeline   by CONTACT id        the id the list hands us
 *   brief      by CONVERSATION id   ← comes from the timeline
 *   memory     by PHONE             ← comes from the timeline's contact
 *
 * So the timeline has to land before the other two can be asked for. Every
 * other loader in this app fans out; this one cannot, and the cost is one
 * extra round trip on a page that already costs three.
 *
 * ── EACH FAILURE IS ITS OWN ──
 * A missing brief does not blank the timeline and a failed memory read does
 * not blank either. They answer different questions, and a merchant who can
 * still read the conversation history is better served than one shown a
 * single error for all three.
 *
 * `null` means WE COULD NOT READ IT and is distinct everywhere from an empty
 * result, which means there is nothing to show. The screen says different
 * sentences for those.
 */
export interface CustomerDetail {
  readonly timeline: CustomerTimeline | null;
  readonly brief: CustomerBrief | null;
  readonly memory: CustomerMemory | null;
  /** The merchant's CRM notes for this person. `null` when the read failed. */
  readonly crm: CrmContext | null;
  /**
   * Screen 04d. `null` when the read failed or there was no conversation to
   * enter through — distinct from the response's own eight states, which are
   * all successful answers about why there are no orders to show.
   */
  readonly orders: CommerceContextResponse | null;
  /**
   * The conversation 04d's actions post through. Exposed rather than
   * recomputed in the component: `readKeyFor` is the one place that choice
   * is made, and a second caller choosing differently is the drift the
   * helper exists to prevent.
   */
  readonly conversationId: string | null;
  /**
   * True when the person has no conversations at all, so the brief was never
   * requested rather than requested and missing.
   *
   * Without this the screen cannot tell "we asked and there is none" from
   * "there was no door to ask through", and those are different sentences.
   */
  readonly noConversations: boolean;
  /** Screen 04e. Three answers, because "not allowed" is not "broken". */
  readonly actions: AuditRead;
  /**
   * Screen 04f. `null` when the read failed — distinct from an empty list,
   * which means nobody has written anything and is a perfectly good screen.
   */
  readonly notes: readonly Note[] | null;
  /**
   * GOTCHA's actions on this person — 02's violet rows in "Everything".
   *
   * ★ THE TIMELINE CARRIES NONE OF THEM. `identity/:id/timeline` returned
   * only messages for a customer with 28 approval requests in their
   * conversations; the supervisor found them in the database and none on
   * the screen. They are read from the approvals list, one read per status,
   * and kept when their conversation is one of this person's or their
   * `contactId` is. `contactId` is optional at the write site, and on dev
   * it was set on 0 of that customer's 28 rows — so the conversation is the
   * join that holds, and `?contactId=` alone would return nothing.
   *
   * ⚠ The list route caps each status at 100, tenant-wide: on a busy tenant
   * an older action can fall outside the window. `null` when every read
   * failed; a partial failure keeps what came back.
   */
  readonly approvals: readonly Approval[] | null;
  /**
   * The viewer's `User.id`, for deciding who may edit a note.
   *
   * ★ NOT THE SESSION'S `sub`. That is the Authentik subject; `authorUserId`
   * holds `User.id`, and `/api/auth/me` is what maps one to the other. Two
   * different identifiers for the same person, and comparing the wrong pair
   * would hide the edit control from everybody, including the author.
   *
   * `null` when the read failed: nobody is offered an edit they may not have,
   * which is the safe direction and costs only a control that reappears on
   * the next load.
   */
  readonly viewerUserId: string | null;
  /**
   * The reads that were ATTEMPTED and FAILED, by name.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ★★ THIS EXISTS BECAUSE THE CAPTURE FIXTURE HID A READ THAT RETURNED
   *    NOTHING, AND EVERY TEST PASSED OVER IT
   * ════════════════════════════════════════════════════════════════════════
   * On 2026-09-25 the 04e read failed on all six capture runs — a contract
   * and an envelope disagreeing — and the spec's own tripwire for exactly
   * that (`customer-actions-failed` must not appear) never fired.
   * `withDetailFixtures` had already replaced the whole detail with the
   * fixture, whose audit state is `ok`. The screen photographed healthy, the
   * log said otherwise, and 84 assertions agreed with the screen.
   *
   * The fixture file's own header says it "must not hide a broken screen",
   * and the guard it wrote for that checks `timeline === null` only —
   * correct when the timeline was the only read that could fail, and
   * silently insufficient from the moment a sibling read was added.
   *
   * ── AND `null` COULD NOT CARRY THIS ──
   * `brief`, `memory`, `crm` and `orders` are all `null` both when the read
   * failed and when it was never attempted — no conversation to ask
   * through, no external id to key on. The fixture gate cannot tell those
   * apart, and preserving the wrong one would report a failure that never
   * happened. So the loader, which DOES know, says so here.
   *
   * The same unknown-versus-negative distinction as `voiceEnabled`,
   * `succeeded` and `coverage`, arrived at from a fifth direction.
   */
  readonly readsFailed: readonly string[];
}

/**
 * What came back from the customer audit log.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `forbidden` IS NOT `failed`, AND NEITHER IS AN EMPTY LIST
 * ════════════════════════════════════════════════════════════════════════════
 * Three different sentences, and a screen that collapsed them would tell
 * somebody to go and fix something depending on which one it picked:
 *
 *   ok         we read it. `data: []` then means nothing was done, which is
 *              a fact about the customer and a perfectly good screen
 *   forbidden  403 — this account may not read the workspace's audit log.
 *              A permission to ask for, not a fault to report
 *   failed     we could not read it. Ours, and it says so
 *
 * The same three-state discipline as `voiceEnabled` and `succeeded`, arrived
 * at for the same reason: **our failure is not a fact about their workspace.**
 */
export type AuditRead =
  | {
      readonly state: 'ok';
      readonly audit: CustomerAudit;
      /**
       * The optional parameters we actually sent.
       *
       * `coverage` is a CONSTANT on the wire — it declares what is
       * attributable in principle, not what this request achieved. Without
       * this the screen would print *"pass ?shopifyCustomerId= to include
       * them"* directly beneath the rows that parameter fetched.
       */
      readonly supplied: readonly string[];
    }
  | { readonly state: 'forbidden' }
  | { readonly state: 'failed' }
  /**
   * We never made the read.
   *
   * ★ ADDED BECAUSE THE COMMENT BESIDE THE FIRST VERSION SAID SO AND THE
   * CODE RETURNED `failed` ANYWAY — the exact costume this project has now
   * caught four times in one day: a comment that describes the right
   * behaviour sitting above code that does not have it.
   *
   * Reached only when the timeline read failed, which renders the whole page
   * as an error and never asks for an audit log at all. `failed` there would
   * report the outcome of a request that was never sent.
   */
  | { readonly state: 'not_asked' };

export async function loadCustomer(contactId: string): Promise<CustomerDetail> {
  const api = serverApi();

  const timeline = await api
    .get({ endpoint: customerEndpoints.timeline(contactId), payload: timelineSchema })
    .catch((cause: unknown) => {
      logger.warn('customer.timeline_failed', { cause });
      return null;
    });

  if (!timeline) {
    /*
     * Through the fixture gate too: a synthetic id 404s by construction, and
     * that failure is not evidence about this screen. See `withDetailFixtures`.
     */
    return withDetailFixtures(
      {
        timeline: null,
        brief: null,
        memory: null,
        crm: null,
        orders: null,
        conversationId: null,
        noConversations: false,
        // Not asked for: without a timeline there is no page to put it on,
        // and `failed` would report a read we never made.
        actions: { state: 'not_asked' },
        notes: null,
        approvals: null,
        viewerUserId: null,
        // The timeline is the failure, and the page renders as one. Nothing
        // else was attempted, so nothing else can be reported as failing.
        readsFailed: [],
      },
      contactId,
    );
  }

  /*
   * ONE shared helper, so four screens cannot each choose differently. Reads
   * only — see the note in `conversation-key.ts` for why a write must not
   * use it.
   */
  const conversationId = readKeyFor(timeline.events);
  /*
   * The phone is the memory's key. `identity/:id/timeline` returns the
   * EFFECTIVE contact — the survivor of any merge — so this is the right
   * identifier even when the page was opened by a merged-away id.
   */
  const externalId = timeline.contact?.externalId?.trim() ?? '';

  /*
   * ★ RECORDED AT THE CATCH, WHERE THE DIFFERENCE IS STILL KNOWN.
   *
   * One line further out every one of these is `null`, and `null` means
   * both "we asked and it failed" and "there was nothing to ask with". Only
   * here can the two be told apart.
   */
  const readsFailed: string[] = [];
  const failing =
    <T>(name: string, event: string) =>
    (cause: unknown): T | null => {
      readsFailed.push(name);
      logger.warn(event, { cause });
      return null;
    };

  const conversationIds = new Set(timeline.events.map((event) => event.conversationId));
  const ownedHere = (approval: Approval) =>
    (approval.conversationId !== null && conversationIds.has(approval.conversationId)) ||
    approval.contactId === contactId ||
    (timeline.contact?.id !== undefined && approval.contactId === timeline.contact.id);
  const approvalsRead = Promise.all(
    APPROVAL_STATUSES.map((status) =>
      api
        .get({ endpoint: approvalEndpoints.list(status), payload: approvalsSchema })
        .catch((cause: unknown) => {
          logger.warn('customer.approvals_failed', { cause, status });
          return null;
        }),
    ),
  ).then((lists): readonly Approval[] | null => {
    if (lists.every((list) => list === null)) {
      readsFailed.push('approvals');
      return null;
    }
    // By id: a row whose status flips between two reads would arrive twice.
    const byId = new Map(lists.flatMap((list) => list ?? []).map((row) => [row.id, row]));
    return [...byId.values()].filter(ownedHere);
  });

  const [brief, memory, crm, orders, notes, viewerUserId, approvals] = await Promise.all([
    /*
     * ★ BY CONTACT, NOT BY CONVERSATION — Backend added the entry point
     * after this screen reported the door problem.
     *
     * It resolves the person internally, follows the soft-merge pointer, and
     * answers `reason: "no_conversations"` for somebody who has never
     * written rather than erroring. So the brief is no longer one of the
     * conversation-keyed reads, and this page no longer has to choose a
     * conversation on its behalf.
     *
     * ⚠ STILL NO `refresh`. The route falls back to inline generation when
     * that flag is set, which is a live model call on a page load — on a
     * screen somebody opens to read, not to regenerate.
     */
    api
      .post({
        endpoint: customerEndpoints.summary(),
        body: { contactId },
        payload: briefSchema,
      })
      .catch(failing<CustomerBrief>('brief', 'customer.brief_failed')),
    externalId
      ? api
          .get({ endpoint: customerEndpoints.memory(externalId), payload: memorySchema })
          .catch(failing<CustomerMemory>('memory', 'customer.memory_failed'))
      : Promise.resolve(null),
    conversationId
      ? api
          .get({
            endpoint: customerEndpoints.crmContext(conversationId),
            payload: crmContextSchema,
          })
          .catch(failing<CrmContext>('crm', 'customer.crm_failed'))
      : Promise.resolve(null),
    conversationId
      ? api
          .get({
            endpoint: customerEndpoints.orders(conversationId),
            payload: commerceContextSchema,
            /*
             * ════════════════════════════════════════════════════════════
             * ★★ FOUND BY SWEEPING THE NAME, AND IT WAS DORMANT FOR THE
             *    SAME REASON THE VOICE COLLAPSE WAS
             * ════════════════════════════════════════════════════════════
             * The route answers the union UNENVELOPED — `res.json(result)`
             * where `result` is `{ state, data }` for `ok`. The client sees
             * a top-level `data` key, unwraps it, and hands the bare
             * `CommerceContext` to a schema that requires `state`. The
             * parse fails, and 04d renders "we couldn't read your orders".
             *
             * ★ IT HAS NEVER FIRED, BECAUSE THE ONLY STATE THIS TENANT CAN
             * PRODUCE HAS NO `data` KEY. Shopify is in ERROR here, so the
             * answer is `{ state: "connection_unhealthy" }`, nothing is
             * unwrapped, and every test and capture has passed over a
             * screen whose success path could not work. Connect a store and
             * 04d breaks on the spot.
             *
             * And it cascades: `shopifyCustomerIdIn` reads `data.customer`,
             * so 04e would never send `?shopifyCustomerId=` and would print
             * the "pass it" gap for good.
             */
            raw: true,
          })
          .catch(failing<CommerceContextResponse>('orders', 'customer.orders_failed'))
      : Promise.resolve(null),
    /*
     * ★ 04f JOINS THE FAN-OUT, AND 04e COULD NOT.
     *
     * Notes are CONTACT-keyed — the stub they replaced was conversation-keyed
     * and that was the defect. So this needs nothing from the other three
     * answers and costs no extra round trip, unlike the audit read, which
     * waits on the commerce read for `shopifyCustomerId`.
     */
    api
      .get({ endpoint: customerEndpoints.notes(contactId), payload: noteListSchema })
      .then((page) => page.notes)
      .catch(failing<readonly Note[]>('notes', 'customer.notes_failed')),
    /*
     * Who is reading, so the edit control appears for the author and nobody
     * else. A failure leaves it `null` and hides the control — safe, and
     * recorded as a failed read so the capture fixture cannot mask it.
     */
    api
      .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
      .then((me) => me.user.id)
      .catch(failing<string>('viewer', 'customer.viewer_failed')),
    approvalsRead,
  ]);

  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ 04e CANNOT JOIN THE FAN-OUT, AND THE REASON IS THE SAME ONE AS 04b's
   * ════════════════════════════════════════════════════════════════════════
   * `?shopifyCustomerId=` is what makes customer-keyed audit rows
   * attributable, and its value is the VERIFIED provider customer id that
   * only the commerce read can give us. So this is a fourth round trip on a
   * page that already costs three, for the same reason the timeline blocks
   * the brief: the key comes out of the previous answer.
   *
   * Issuing it in parallel without the id would be cheaper and would quietly
   * drop every row keyed to the customer rather than the conversation —
   * which the endpoint would then correctly declare as a gap, and the screen
   * would correctly print. Correct, and a worse screen than the one we can
   * have for one more request.
   */
  const shopifyCustomerId = shopifyCustomerIdIn(orders);
  const supplied = shopifyCustomerId ? ['shopifyCustomerId'] : [];
  const actions: AuditRead = await api
    .get({
      endpoint: customerEndpoints.audit(contactId),
      payload: customerAuditSchema,
      /*
       * ★★ `data` IS A SIBLING HERE, NOT THE PAYLOAD.
       *
       * The answer is `{ contact, data, nextCursor, coverage, scope }`.
       * Without this the client unwraps the envelope and hands `.data` — an
       * ARRAY — to a schema expecting an object, so the parse fails at
       * `(root)` on a perfectly good 200.
       *
       * The flag's own doc names this case for `/api/notifications`
       * (`{ data, nextCursor }`) and I read that sentence, wrote a contract
       * for a five-key envelope, and did not apply it. This route is the
       * same shape three keys wider.
       */
      raw: true,
      ...(shopifyCustomerId ? { query: { shopifyCustomerId } } : {}),
    })
    .then((audit): AuditRead => ({ state: 'ok', audit, supplied }))
    .catch((cause: unknown): AuditRead => {
      /*
       * A 403 is an answer, not a failure. The route is gated on
       * `crm:contacts:read` or ADMIN — whoever can open screen 04 — so this
       * should not happen for anyone who reached this page, and if it does,
       * the repair is a permission rather than a retry.
       */
      if (cause instanceof ApiError && cause.kind === 'authorization') {
        logger.warn('customer.audit_forbidden', { cause });
        return { state: 'forbidden' };
      }
      readsFailed.push('actions');
      logger.warn('customer.audit_failed', { cause });
      return { state: 'failed' };
    });

  /*
   * ★ SUBSTITUTED LAST, AND ONLY UNDER THE GATE.
   *
   * This page renders the BODIES of a real person's messages, a written
   * character study of them and the durable facts GOTCHA has learned — far
   * more exposure than the list, which already justified a fixture.
   *
   * Applied to what the real reads returned, so a failure stays a failure.
   */
  return withDetailFixtures(
    {
      timeline,
      brief,
      memory,
      crm,
      orders,
      conversationId,
      noConversations: conversationId === null,
      actions,
      notes,
      approvals,
      viewerUserId,
      readsFailed,
    },
    contactId,
  );
}
