import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  conversationRowSchema,
  messageSchema,
  type ConversationRow,
  type InboxMessage,
} from '@/api/contracts/inbox';
import type { CustomerTimeline } from '@/api/contracts/customer-detail';
import {
  commerceContextSchema,
  type CommerceContextResponse,
} from '@/api/contracts/customer-orders';
import { customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { z } from 'zod';

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

const queuePageSchema = z.object({
  data: z.array(conversationRowSchema),
});

const streamPageSchema = z.object({
  data: z.array(messageSchema),
});

export interface InboxData {
  readonly rows: readonly ConversationRow[] | null;
  readonly open: ConversationRow | null;
  readonly messages: readonly InboxMessage[] | null;
  readonly timeline: CustomerTimeline | null;
  readonly orders: CommerceContextResponse | null;
}

export async function loadInbox(conversationId?: string): Promise<InboxData> {
  const api = serverApi();

  const rows = await api
    .get({
      endpoint: inboxEndpoints.list(),
      payload: queuePageSchema,
      // `{ data }` beside a page envelope — checked, not assumed.
      raw: true,
      /*
       * ★ ONE PAGE. The endpoint paginates by offset, and on a recency
       * ordering that silently skips rows between pages. See
       * `ConversationList` for why a skip in a queue is not cosmetic.
       */
      query: { limit: QUEUE_CAP },
    })
    .then((page) => page.data)
    .catch((cause: unknown) => {
      logger.warn('inbox.queue_failed', { cause });
      return null;
    });

  /*
   * The conversation to show. An explicit id wins; otherwise the first row
   * the queue gave us — and NOT the first undated one, which has no claim to
   * being most recent.
   */
  const open = (conversationId ? rows?.find((r) => r.id === conversationId) : rows?.[0]) ?? null;

  if (!open) return { rows, open: null, messages: null, timeline: null, orders: null };

  const [messages, timeline, orders] = await Promise.all([
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
  ]);

  return { rows, open, messages, timeline, orders };
}
