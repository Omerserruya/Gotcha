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
  /** The server's own per-package cap, and the cap itself when it sends it. */
  | { readonly ok: false; readonly kind: 'too_many'; readonly max: number | null }
  /**
   * The pack cannot be bought on this plan, or is no longer sold. Nothing was
   * charged and trying again will not help — a different repair from either.
   */
  | { readonly ok: false; readonly kind: 'not_purchasable' }
  /**
   * ★★ WE DO NOT KNOW WHAT HAPPENED, WHICH IS NOT "NOTHING HAPPENED".
   *
   * This used to render `buy.declined` — *"The payment didn't go through,
   * and nothing was charged."* A network drop, a 500, or a response that
   * failed its contract all land here, and **a contract failure can happen
   * after a 200 in which the card was charged and the credits granted**.
   * Telling that customer nothing was charged is the same harm `unsettled`
   * exists to prevent, arriving through the parse instead of the provider.
   */
  | { readonly ok: false; readonly kind: 'failed' };

/**
 * Refusals that mean "not this pack, not on this plan" rather than "not now".
 *
 * Four of them are the package's own availability window
 * (`checkPackageAvailability`) and two are the plan's eligibility. They share
 * a repair — the list the customer is looking at is out of date, or this plan
 * cannot buy packs — and none of them is helped by trying again.
 */
const NOT_PURCHASABLE: ReadonlySet<string> = new Set([
  'unknown_package',
  'package_inactive',
  'package_not_yet_active',
  'package_expired',
  'package_not_eligible_for_plan',
  'plan_not_eligible_for_packages',
]);

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

    /*
     * ★★ A NON-SUCCESS NEVER ARRIVES HERE.
     *
     * The route is `res.status(result.success ? 200 : 402).json(result)`, so
     * every refusal is a 402 and every 402 throws. The branches that used to
     * follow this one — `outcomeUnknown`, `no_billable_entity`, `declined` —
     * read the body of a 200 that cannot be a failure, and **all three were
     * unreachable**, including the sentence about a declined card, which is
     * the one this screen most needs to be able to say. They live in the
     * catch now, which is where the refusal actually lands.
     */
    revalidatePath('/[locale]/(app)/settings/billing', 'page');
    return { ok: true, units: result.units, invoiceId: result.invoiceId };
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
        // ★ AND NOW WITH THE REFERENCE. The 409 body carries `invoiceId` and
        // the error envelope used to strip it, so a merchant ringing about a
        // charge whose outcome is unknown could not be given anything to
        // quote. `null` stays null — an absent id is not printed as one.
        return { ok: false, kind: 'unsettled', invoiceId: cause.invoiceId ?? null };
      }

      /*
       * ★★ `failureCode`, NOT `code`. This was `cause.code`, the idiom every
       * other action here uses, and it could not fire: the billing services
       * answer `{ success: false, failureCode, detail }` with no `code` and
       * no `error` — and `error` being required meant the envelope parse
       * failed outright, so the whole body was discarded. Every refusal on
       * the screen that charges a card rendered as the same generic sentence.
       */
      const failure = cause.failureCode;
      if (failure === 'quantity_exceeds_maximum') {
        const max = cause.failureDetail?.max;
        return { ok: false, kind: 'too_many', max: typeof max === 'number' ? max : null };
      }
      if (failure === 'no_billable_entity') return { ok: false, kind: 'no_billable_entity' };
      if (failure !== undefined && NOT_PURCHASABLE.has(failure)) {
        return { ok: false, kind: 'not_purchasable' };
      }
      /*
       * ★★ THE CARD WAS REACHED, SO THIS IS A DECLINE AND NOT A REFUSAL.
       * `buyCredits` sets `invoiceId` on a failure only from `chargeFor`'s
       * result — every earlier refusal returns without one. So its presence
       * is the platform's own record that the charge was attempted, which is
       * the difference between "we declined to charge you" and "your card
       * said no". `unsettled` has already been taken out above.
       */
      if (cause.invoiceId) {
        logger.warn('billing.buy_declined', { packageKey, failure });
        return { ok: false, kind: 'declined', code: failure ?? null };
      }
      /*
       * A refusal this build has not seen. It falls through to `failed`,
       * which no longer claims nothing was charged — and the code is logged,
       * so the next one is a name rather than a mystery.
       */
      if (failure !== undefined) {
        logger.warn('billing.buy_unmapped_failure', { packageKey, failure });
      }
    }
    logger.warn('billing.buy_failed', { cause, packageKey });
    return { ok: false, kind: 'failed' };
  }
}
