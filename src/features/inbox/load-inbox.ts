import 'server-only';

import { viewQuery, type InboxView, type QueueChannelFilter } from './inbox-views';
import { serverApi } from '@/api/client/server-api';
import {
  autoGreetingSchema,
  colleagueListSchema,
  conversationRowSchema,
  messageSchema,
  transferableTo,
  type Colleague,
  type ConversationRow,
  type InboxMessage,
} from '@/api/contracts/inbox';
import type { CustomerTimeline } from '@/api/contracts/customer-detail';
import {
  commerceContextSchema,
  type CommerceContextResponse,
} from '@/api/contracts/customer-orders';
import { currentUserSchema } from '@/api/contracts/identity';
import { authEndpoints, customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { z } from 'zod';
import { loadCopilot, type CopilotRead } from './load-copilot';

/**
 * What screen 02 reads.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ FOUR PANELS, FOUR INDEPENDENT FAILURES
 * ════════════════════════════════════════════════════════════════════════════
 * The design's premise is *"conversation, commerce context, AI execution and
 * customer identity as PEERS in one view, not a chat window with a sidebar
 * bolted on"*. Peers fail independently: a commerce read that 403s because
 * this agent lacks `customer:commerce:read` must not blank the conversation
 * they were sent here to answer.
 *
 * So every read degrades on its own and `null` everywhere means **we could
 * not read it**, never "there is none".
 *
 * ── AND THE ORDER IS FORCED, NOT PREFERRED ──
 * The queue lands first because the open conversation supplies the contact
 * id for the identity read and its own id for the commerce read. Same shape
 * as 04b's timeline-then-brief: the key comes out of the previous answer.
 */
export const QUEUE_CAP = 50;

/**
 * ★ THE KEYSET SHAPE, AND `hasMore` IS LOAD-BEARING ON SCREEN.
 *
 * Passing `cursor` switches the route from offset to keyset — ordered
 * `{ lastMessageAt: desc, nulls: last }` with a `(timestamp, id)` tiebreak,
 * so a new message between pages no longer skips a row.
 *
 * `hasMore` is not only a button state: undated rows sort **last**, so only
 * on the final page can the screen say "these are the undated ones" about
 * the queue rather than about the page. See `ConversationList`.
 */
const queuePageSchema = z.object({
  data: z.array(conversationRowSchema),
  page: z.object({
    limit: z.number().default(0),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ OPTIONAL, AND ABSENT IS NOT ZERO
   * ════════════════════════════════════════════════════════════════════════
   * How many conversations in THIS VIEW have no `lastMessageAt` — scoped to
   * the caller's filters including the visibility clause, and deliberately
   * **cursor-blind**, so it does not shrink as somebody pages.
   *
   * Three states, and the third is the point:
   *
   *   a number   the count for this view
   *   0          the writers are behaving, and somebody looked
   *   undefined  **the running service predates the count.** Nobody looked.
   *
   * `.optional()` and never `.default(0)`. A default would have the screen
   * assert *"no undated conversations"* on a service that cannot answer the
   * question — the reassuring-direction failure, on the one instrument built
   * to detect a problem that is otherwise invisible. **The instrument would
   * report all-clear because it is not there.**
   *
   * This is the second time today this exact group has hidden the thing it
   * exists to show: first because nulls sort last and the group was empty
   * until the final page, now because the field is absent on a service
   * older than it.
   */
  undatedCount: z.number().optional(),
});

/**
 * Exported so the schema itself can be tested.
 *
 * ★ THE COMPONENT TESTS CANNOT SEE THIS. They pass `undatedCount` straight
 * into the component, so `.optional()` versus `.default(0)` is invisible to
 * them — a mutation swapping the two passed every one of them. The
 * distinction lives in the parse and has to be asserted there.
 *
 * Same shape as a test double being more forgiving than the real thing: the
 * stand-in was built from what the author believed the contract said, so it
 * could not disagree with the author.
 */
export const queuePageSchemaForTests = queuePageSchema;

const streamPageSchema = z.object({
  data: z.array(messageSchema),
});

export interface InboxData {
  readonly rows: readonly ConversationRow[] | null;
  /** More pages exist. `false` when the read failed — we claim nothing. */
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  /**
   * Undated conversations in this view, or `undefined` when the service
   * cannot answer. Never zero by default — see the schema.
   */
  readonly undatedCount: number | undefined;
  readonly open: ConversationRow | null;
  readonly messages: readonly InboxMessage[] | null;
  readonly timeline: CustomerTimeline | null;
  readonly orders: CommerceContextResponse | null;
  /** Never `null`: `loadCopilot` returns which KIND of nothing it got. */
  readonly copilot: CopilotRead;
  /** `User.id` of the person looking, or `null` when we could not read it. */
  readonly meId: string | null;
  /** Active colleagues this viewer may transfer to. Never includes them. */
  readonly colleagues: readonly { readonly id: string; readonly name: string }[];
  /**
   * Does the workspace have an auto-greeting? `null` = we could not ask.
   * The read is ADMIN-only, so `null` is the ordinary answer for an agent.
   */
  readonly greeting: boolean | null;
}

export async function loadInbox(
  conversationId?: string,
  cursor?: string,
  view: InboxView = 'queue',
  /** `null` is "All". Sent as the route's own `channel` filter. */
  channel: QueueChannelFilter | null = null,
): Promise<InboxData> {
  const api = serverApi();

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * ⚠⚠ THIS WAS THREE ROUNDS DEEP AND ONLY TWO OF THEM WERE NECESSARY
   * ═════════════════════════════════════════════════════════════════════════
   * Measured 2026-10-01: the inbox's time-to-first-byte is 738 ms against a
   * 317 ms floor for a page with little data — **420 ms of fetching**, with
   * zero API calls from the browser. All of it is this function.
   *
   * `queue` was awaited ALONE, then `me`/`colleagues`/`greeting` waited behind
   * it — and **none of those three reads anything from the queue.** They sat
   * one full server-to-server round trip behind a result they do not use.
   *
   * ★ THE SECOND ROUND BELOW IS GENUINELY DEPENDENT AND STAYS. `open` is
   *   chosen from the queue's rows, and a conversation's messages cannot be
   *   fetched before knowing which conversation. That dependency is real;
   *   this one was not.
   *
   * ★ SAFE TO MERGE BECAUSE EVERY CALL CATCHES ITS OWN FAILURE. All four
   *   resolve — `queue` to null, `me` to null, `colleagues` to [], `greeting`
   *   to null — so a `Promise.all` over them cannot reject, and each degraded
   *   value still means exactly what it meant before.
   *
   * ⚠ `load-inbox.test.ts` asserts that all four are IN FLIGHT before any
   *   settles. Every other test of this function passes either way, because
   *   the data is identical — only the order is the fix, so only a test about
   *   order protects it.
   */
  /*
   * The viewer, started first because ONE view needs it to build its query.
   */
  const meRead = api
    .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
    .then((it) => it.user.id)
    .catch((cause: unknown) => {
      logger.warn('inbox.me_failed', { cause });
      return null;
    });

  /*
   * ════════════════════════════════════════════════════════════════════════
   * ⚠ `mine` IS THE ONE VIEW WITH A REAL DEPENDENCY, AND ONLY IT WAITS
   * ════════════════════════════════════════════════════════════════════════
   * "Assigned to me" needs `assignedAgentId=<the viewer's platform id>`, and
   * only `/auth/me` knows it. So for that view the queue chains off `meRead`.
   * Every other view starts its queue immediately — four reads in flight,
   * exactly as `load-inbox.test.ts` asserts.
   *
   * ★ `colleagues` and `greeting` run alongside `me` either way: neither reads
   *   the queue, so there is still no extra round for them.
   */
  const fetchQueue = (query: Record<string, string> | null) =>
    query === null
      ? Promise.resolve(null)
      : api
          .get({
            endpoint: inboxEndpoints.list(),
            payload: queuePageSchema,
            // `data` sits beside `page` — checked, not assumed.
            raw: true,
            /*
             * ★ KEYSET, NOT OFFSET. `cursor` switches the route over; the first
             * page passes an empty one, which the route treats as keyset-from-the-
             * start rather than falling back to `skip`.
             *
             * Offset on a recency ordering shows a duplicate and silently skips a
             * row when a new message arrives between pages — somebody waiting who
             * never appears. That is why this waited for the keyset rather than
             * scrolling on offset.
             */
            query: {
              ...query,
              ...(channel === null ? {} : { channel }),
              limit: QUEUE_CAP,
              cursor: cursor ?? '',
            },
          })
          .catch((cause: unknown) => {
            logger.warn('inbox.queue_failed', { cause });
            return null;
          });

  const queueRead =
    view === 'mine'
      ? meRead.then((id) => fetchQueue(viewQuery('mine', id)))
      : fetchQueue(viewQuery(view, null));

  const [queue, me, colleagues, greeting] = await Promise.all([
    queueRead,
    meRead,
    api
      .get({ endpoint: inboxEndpoints.agents(), payload: colleagueListSchema })
      .catch((cause: unknown) => {
        logger.warn('inbox.colleagues_failed', { cause });
        return [] as Colleague[];
      }),
    api
      .get({ endpoint: inboxEndpoints.autoGreeting(), payload: autoGreetingSchema })
      /*
       * A template that is present and non-empty. The route answers
       * `{ template: "" }` for "none configured", so the empty string is a
       * real answer and not a missing one.
       */
      .then((it) => it.template.trim() !== '')
      .catch((cause: unknown) => {
        // 403 for anybody who is not an ADMIN, which is most of the people
        // who will press "take control". Not logged as a warning-worthy
        // failure, because it is the expected answer.
        logger.debug?.('inbox.greeting_unreadable', { cause });
        return null;
      }),
  ]);

  const rows = queue?.data ?? null;

  /*
   * The conversation to show. An explicit id wins; otherwise the first row
   * the queue gave us — and NOT the first undated one, which has no claim to
   * being most recent.
   */
  const open = (conversationId ? rows?.find((r) => r.id === conversationId) : rows?.[0]) ?? null;

  const paging = {
    // A failed read claims nothing about what else exists.
    hasMore: queue?.page.hasMore ?? false,
    nextCursor: queue?.page.nextCursor ?? null,
    /*
     * `?? undefined` and never `?? 0`. A failed read and a service that
     * cannot count are the same fact here — nobody looked — and both must
     * stay distinguishable from a service that looked and found none.
     */
    undatedCount: queue?.undatedCount,
  };

  /*
   * ★ WHO IS LOOKING, WHO THEY CAN HAND IT TO, AND WHETHER THE CUSTOMER GETS
   *   A MESSAGE. All three degrade to "we do not know" rather than to a
   *   confident answer, and each one is a different question:
   *
   *     meId      null → nothing is "mine", so no transfer control is drawn.
   *                      Withholding a control on an unknown is right here:
   *                      the route would 403 anyway.
   *     colleagues empty → the transfer control is not drawn at all. A select
   *                      with no options is a control that cannot be used.
   *     greeting  null → the hedged sentence. NOT `false`, which would
   *                      promise the customer hears nothing.
   */

  const viewer = {
    meId: me,
    colleagues: transferableTo(colleagues, me),
    greeting,
  };

  if (!open) {
    return {
      rows,
      ...paging,
      ...viewer,
      open: null,
      messages: null,
      timeline: null,
      orders: null,
      /*
       * Nothing is open, so nothing was asked. Not a failure and not a refusal —
       * `unavailable` is the closest honest answer and the panel is not rendered
       * in this branch anyway.
       */
      copilot: { state: 'unavailable' },
    };
  }

  const [messages, timeline, orders, copilot] = await Promise.all([
    api
      .get({ endpoint: inboxEndpoints.messages(open.id), payload: streamPageSchema, raw: true })
      .then((page) => page.data)
      .catch((cause: unknown) => {
        logger.warn('inbox.stream_failed', { cause });
        return null;
      }),
    /*
     * ★★ NOT READ, AND NOT BECAUSE IT FAILED.
     *
     * The identity reads are keyed on a CONTACT id. `Conversation` has none
     * — it carries `customerExternalId` and `channel`, the handle this
     * conversation arrived on. `resolveContactByChannelId` exists as a
     * shared function used by two services and **is not routed as a GET**,
     * so there is nothing to call.
     *
     * `null` here therefore means "no contact id to try", and
     * `IdentityPanel` falls back to the conversation's own handle with a
     * caption saying so. It does not mean a read failed, and the panel does
     * not render a failure.
     */
    Promise.resolve(null as CustomerTimeline | null),
    /*
     * ★★ 04d's PANEL, NOT A SECOND ONE.
     *
     * Same endpoint, same contract, same eight states, keyed on the open
     * conversation instead of one resolved from a timeline. A second
     * commerce contract would be two answers to a question about money,
     * both rendered confidently, to the same person on the same afternoon.
     */
    api
      .get({
        endpoint: customerEndpoints.orders(open.id),
        payload: commerceContextSchema,
        // The union arrives unenveloped as `{ state, data }`.
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('inbox.orders_failed', { cause });
        return null;
      }),
    /*
     * ★★ A PEER, AND ITS 402 IS AN ORDINARY STATE.
     *
     * `requireEntitlement('ai.copilot')` refuses this for any tenant whose plan
     * does not include Copilot — which is Foundation, a plan the company sells.
     * So the read must not take the conversation down with it, and its refusal
     * must not be read as the whole tenant being gated, which is what
     * `tenantGateFrom` used to do with it.
     *
     * `loadCopilot` owns that distinction and never throws.
     */
    loadCopilot(open.id),
  ]);

  return { rows, ...paging, ...viewer, open, messages, timeline, orders, copilot };
}
