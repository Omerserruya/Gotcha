'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { buyResultSchema } from '@/api/contracts/pricing';
import { billingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Screen 17d's write. It charges a card.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ THE OUTCOME THAT MUST NEVER OFFER A RETRY
 * ════════════════════════════════════════════════════════════════════════════
 * `POST /billing/credits/buy` answers **409** when the provider has not
 * settled the charge, deliberately rather than 402, and the route says why:
 *
 *   > A payment-required response invites the customer to try again, and they
 *   > may already have been charged.
 *
 * So `unsettled` is a third outcome, not a kind of failure. It must not say
 * "failed", must not offer "try again", and must say that a charge may have
 * gone through. Collapsing three outcomes into "Something went wrong, try
 * again" — which is exactly what a redesign does to error states — takes
 * money from somebody twice.
 */
export type BuyOutcome =
  | { readonly ok: true; readonly units: number | null; readonly invoiceId: string | null }
  /** Settled, and it did not go through. Safe to try again. */
  | { readonly ok: false; readonly kind: 'declined'; readonly code: string | null }
  /** Not settled. NOT safe to try again, and it may have been charged. */
  | { readonly ok: false; readonly kind: 'unsettled'; readonly invoiceId: string | null }
  /** There is nothing to bill. A different repair entirely. */
  | { readonly ok: false; readonly kind: 'no_billable_entity' }
  /** The server's own per-package cap. */
  | { readonly ok: false; readonly kind: 'too_many'; readonly max: number | null }
  | { readonly ok: false; readonly kind: 'failed' };

/**
 * `intentKey` identifies ONE purchase the customer decided on, so the server
 * turns a double-click into a single charge. It is minted by the caller when
 * the CHOICE is made — passing one generated per click would defeat the
 * whole mechanism while looking identical from here.
 */
export async function buyCreditPack(
  packageKey: string,
  quantity: number,
  intentKey: string,
): Promise<BuyOutcome> {
  try {
    const result = await serverApi().post({
      endpoint: billingEndpoints.creditsBuy(),
      body: { packageKey, quantity, intentKey },
      payload: buyResultSchema,
    });

    if (result.success) {
      revalidatePath('/[locale]/(app)/settings/billing', 'page');
      return { ok: true, units: result.units, invoiceId: result.invoiceId };
    }
    // A 200 that is not a success. Read the code rather than the status.
    if (result.outcomeUnknown) return { ok: false, kind: 'unsettled', invoiceId: result.invoiceId };
    if (result.failureCode === 'no_billable_entity') {
      return { ok: false, kind: 'no_billable_entity' };
    }
    return { ok: false, kind: 'declined', code: result.failureCode };
  } catch (cause: unknown) {
    /*
     * The 409 arrives as a thrown API error, so the unsettled case has TWO
     * paths into this function and both must reach the same outcome. Handling
     * only the body would leave the most dangerous answer falling through to
     * "failed" — which renders a retry.
     */
    if (isApiError(cause)) {
      /*
       * `ApiError` carries status, code and field errors — NOT the response
       * body. So the invoice id that the 409 payload holds cannot be
       * recovered here, and the screen says "a charge may have been made"
       * without a reference rather than printing a null one.
       *
       * Worth stating rather than quietly passing null: a merchant ringing
       * support about an unsettled charge is better served by "we cannot show
       * you a reference, here is what to do" than by a blank where an id
       * should be.
       */
      if (cause.status === 409) {
        logger.warn('billing.buy_outcome_unknown', { packageKey });
        return { ok: false, kind: 'unsettled', invoiceId: null };
      }
      if (cause.code === 'quantity_exceeds_maximum') {
        return { ok: false, kind: 'too_many', max: null };
      }
    }
    logger.warn('billing.buy_failed', { cause, packageKey });
    return { ok: false, kind: 'failed' };
  }
}
