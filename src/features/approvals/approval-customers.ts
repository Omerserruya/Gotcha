import 'server-only';

import { z } from 'zod';

import type { Approval } from '@/api/contracts/approvals';
import { briefSchema } from '@/api/contracts/customer-detail';
import { commerceContextSchema } from '@/api/contracts/customer-orders';
import { serverApi } from '@/api/client/server-api';
import { customerEndpoints, inboxEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * 03's "The customer" card, per pending request — every fact `null` where its
 * read is not possible or failed, and drawn as "—" then.
 *
 *   name     the contact's, else the conversation's `customerName`
 *   since    the contact's `createdAt` — with you since
 *   lifetime the store's lifetime spend (commerce context; needs a conversation)
 *   refunds  refunded-or-cancelled orders (the same read)
 *   mood     the written brief's mood (`POST /api/customer-summary`, no refresh)
 *
 * No order COUNT: the commerce summary carries open orders and refunds, not a
 * total, and a count of the recent ones shown would be a short count.
 */
export interface ApprovalCustomer {
  readonly name: string | null;
  readonly since: string | null;
  readonly lifetime: { readonly amount: number; readonly currency: string } | null;
  readonly refunds: number | null;
  readonly mood: string | null;
}

/** The two facts this card reads from `GET /api/contacts/:id`. */
const contactSchema = z.object({
  displayName: z.string().nullable().catch(null).default(null),
  createdAt: z.string().nullable().catch(null).default(null),
});

/** A queue is short; past this, the rest are read when they are opened. */
const READ_AT_MOST = 10;

export async function loadApprovalCustomers(
  pending: readonly Approval[],
): Promise<Record<string, ApprovalCustomer>> {
  const api = serverApi();
  const quiet = (event: string) => (cause: unknown) => {
    logger.warn(event, { cause });
    return null;
  };

  const rows = await Promise.all(
    pending.slice(0, READ_AT_MOST).map(async (approval) => {
      const { contactId, conversationId } = approval;
      const [contact, conversation, commerce, brief] = await Promise.all([
        contactId
          ? api
              .get({ endpoint: customerEndpoints.detail(contactId), payload: contactSchema })
              .catch(quiet('approvals.customer_contact_failed'))
          : null,
        conversationId
          ? api
              .get({
                endpoint: inboxEndpoints.conversation(conversationId),
                payload: z.object({
                  customerName: z.string().nullable().catch(null).default(null),
                }),
              })
              .catch(quiet('approvals.customer_conversation_failed'))
          : null,
        conversationId
          ? api
              .get({
                endpoint: customerEndpoints.orders(conversationId),
                payload: commerceContextSchema,
                raw: true,
              })
              .catch(quiet('approvals.customer_orders_failed'))
          : null,
        contactId
          ? api
              .post({
                endpoint: customerEndpoints.summary(),
                body: { contactId },
                payload: briefSchema,
              })
              .catch(quiet('approvals.customer_brief_failed'))
          : null,
      ]);
      const summary = commerce?.summary ?? commerce?.data?.summary ?? null;
      const total = summary?.shopCurrencyTotal;
      const customer: ApprovalCustomer = {
        name: contact?.displayName?.trim() || conversation?.customerName?.trim() || null,
        since: contact?.createdAt ?? null,
        lifetime:
          total && typeof total.amount === 'number' && total.currency
            ? { amount: total.amount, currency: total.currency }
            : null,
        refunds: summary?.refundedOrCancelledCount ?? null,
        mood: brief?.ok ? brief.meta.mood?.trim() || null : null,
      };
      return [approval.id, customer] as const;
    }),
  );
  return Object.fromEntries(rows);
}
