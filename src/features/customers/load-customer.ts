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

  const [brief, memory, crm, orders] = await Promise.all([
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
      .catch((cause: unknown) => {
        logger.warn('customer.brief_failed', { cause });
        return null;
      }),
    externalId
      ? api
          .get({ endpoint: customerEndpoints.memory(externalId), payload: memorySchema })
          .catch((cause: unknown) => {
            logger.warn('customer.memory_failed', { cause });
            return null;
          })
      : Promise.resolve(null),
    conversationId
      ? api
          .get({
            endpoint: customerEndpoints.crmContext(conversationId),
            payload: crmContextSchema,
          })
          .catch((cause: unknown) => {
            logger.warn('customer.crm_failed', { cause });
            return null;
          })
      : Promise.resolve(null),
    conversationId
      ? api
          .get({
            endpoint: customerEndpoints.orders(conversationId),
            payload: commerceContextSchema,
          })
          .catch((cause: unknown) => {
            logger.warn('customer.orders_failed', { cause });
            return null;
          })
      : Promise.resolve(null),
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
    },
    contactId,
  );
}
