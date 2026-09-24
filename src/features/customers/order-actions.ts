'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  orderActionResultSchema,
  type OrderAction,
  type OrderActionResult,
} from '@/api/contracts/customer-orders';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Screen 04d's writes. They move real money in a real store.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ WHY THIS IS ALLOWED FROM A CUSTOMER PAGE WHEN A NOTE IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 * Both endpoints are keyed on a conversation, and the customer page has to
 * choose one. The difference is what the conversation becomes in the record:
 *
 *   createNote        `source_interaction_id: conversationId` — the
 *                     ATTRIBUTION, in the merchant's own CRM, uncorrectable
 *   commerce action   `targetType: "customer" | "order"` with the
 *                     conversation in free-form `metadata` as CONTEXT
 *
 * So the audit's subject is already the right one. **A conversation key is a
 * problem when it is the record's identity and acceptable when it is context
 * on a record already keyed to the person.** Notes fail that test; these pass.
 *
 * ── AND THE RESULT IS THE ONLY SOURCE OF THE NEW STATE ──
 * `commerce-actions.service.ts` runs a post-action verify and returns what
 * the provider actually reports. Its header: *"a button click never mutates
 * order state in the UI; the caller updates only from the verified result
 * returned here."* Nothing here is optimistic.
 */
export async function runOrderAction(
  conversationId: string,
  orderId: string,
  action: OrderAction,
  idempotencyKey: string,
): Promise<OrderActionResult | null> {
  try {
    const result = await serverApi().post({
      endpoint: customerEndpoints.orderAction(conversationId),
      /*
       * Only the KEYS. Price, amount and the order's contents are read from
       * the provider inside the service, never from this request — the same
       * refusal as `buyCredits`, and for the same reason: a body that can
       * name an amount is a body that can name the wrong one.
       */
      body: { action, orderId, idempotencyKey },
      payload: orderActionResultSchema,
    });

    /*
     * Revalidate only after the provider has been verified. The page then
     * re-reads the order from the store, which is a second confirmation
     * rather than a substitute for the first.
     */
    if (result.state === 'executed' || result.state === 'executed_customer') {
      revalidatePath('/[locale]/(app)/customers/[id]', 'page');
    }
    return result;
  } catch (cause: unknown) {
    /*
     * A thrown error is NOT "the action failed". It is "we do not know what
     * happened" — the same distinction as the unsettled charge on 17d, and
     * the same consequence: never invite a retry on an unknown outcome,
     * because a refund taken twice is somebody's money gone twice.
     */
    logger.warn('customer.order_action_failed', {
      cause,
      action,
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}
