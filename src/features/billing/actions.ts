'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { buyResultSchema } from '@/api/contracts/pricing';
import {
  planChangePreviewSchema,
  planChangeResultSchema,
  type PlanChangePreview,
} from '@/api/contracts/billing';
import { billingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

import { billingWritesEnabled } from '@/api/client/billing-writes';

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
 * again" - which is exactly what a redesign does to error states - takes
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
   * charged and trying again will not help - a different repair from either.
   */
  | { readonly ok: false; readonly kind: 'not_purchasable' }
  /**
   * ★★ WE DO NOT KNOW WHAT HAPPENED, WHICH IS NOT "NOTHING HAPPENED".
   *
   * This used to render `buy.declined` - *"The payment didn't go through,
   * and nothing was charged."* A network drop, a 500, or a response that
   * failed its contract all land here, and **a contract failure can happen
   * after a 200 in which the card was charged and the credits granted**.
   * Telling that customer nothing was charged is the same harm `unsettled`
   * exists to prevent, arriving through the parse instead of the provider.
   */
  | { readonly ok: false; readonly kind: 'failed' }
  /**
   * Billing writes are off for this deployment (BILLING_WRITES, fail closed):
   * refused here, before any call - nothing was charged.
   */
  | { readonly ok: false; readonly kind: 'held' };

/**
 * Refusals that mean "not this pack, not on this plan" rather than "not now".
 *
 * Four of them are the package's own availability window
 * (`checkPackageAvailability`) and two are the plan's eligibility. They share
 * a repair - the list the customer is looking at is out of date, or this plan
 * cannot buy packs - and none of them is helped by trying again.
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
 * the CHOICE is made - passing one generated per click would defeat the
 * whole mechanism while looking identical from here.
 */
export async function buyCreditPack(
  packageKey: string,
  quantity: number,
  intentKey: string,
): Promise<BuyOutcome> {
  // The action itself refuses, not only the button: dev's billing is the live account.
  if (!billingWritesEnabled()) return { ok: false, kind: 'held' };
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
     * follow this one - `outcomeUnknown`, `no_billable_entity`, `declined` -
     * read the body of a 200 that cannot be a failure, and **all three were
     * unreachable**, including the sentence about a declined card, which is
     * the one this screen most needs to be able to say. They live in the
     * catch now, which is where the refusal actually lands.
     */
    revalidatePath('/[locale]/(app)/settings/billing', 'page');
    return { ok: true, units: result.units, invoiceId: result.invoiceId };
  } catch (cause: unknown) {
    await signInIfSignedOut(cause);
    /*
     * The 409 arrives as a thrown API error, so the unsettled case has TWO
     * paths into this function and both must reach the same outcome. Handling
     * only the body would leave the most dangerous answer falling through to
     * "failed" - which renders a retry.
     */
    if (isApiError(cause)) {
      /*
       * `ApiError` carries status, code and field errors - NOT the response
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
        // quote. `null` stays null - an absent id is not printed as one.
        return { ok: false, kind: 'unsettled', invoiceId: cause.invoiceId ?? null };
      }

      /*
       * ★★ `failureCode`, NOT `code`. This was `cause.code`, the idiom every
       * other action here uses, and it could not fire: the billing services
       * answer `{ success: false, failureCode, detail }` with no `code` and
       * no `error` - and `error` being required meant the envelope parse
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
       * result - every earlier refusal returns without one. So its presence
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
       * which no longer claims nothing was charged - and the code is logged,
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

export interface BillingDetails {
  readonly billingName: string;
  readonly vatId: string;
  readonly billingAddress: string;
  readonly billingCountry: string;
  readonly billingEmail: string;
}

export type SaveDetailsResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid_country' | 'no_record' | 'forbidden' | 'failed';
    };

/**
 * 17e's Save details - `PUT /billing/profile`, database only (no provider
 * call; verified in the route and by Backend, 2026-10-08).
 *
 * ⚠ THE ROUTE REPLACES ALL FIVE: a field not sent is stored as null. So the
 *   form always sends every field as it stands - an empty one clears it, on
 *   purpose. 409 is "no billing record yet" (one is made when a card is
 *   added); 400 is a country that is not two letters, which selects a tax
 *   rate and so is checked here first.
 */
export async function saveBillingProfile(details: BillingDetails): Promise<SaveDetailsResult> {
  const country = details.billingCountry.trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) return { ok: false, reason: 'invalid_country' };
  try {
    await serverApi().put({
      endpoint: billingEndpoints.profile(),
      body: {
        billingName: details.billingName.trim(),
        vatId: details.vatId.trim(),
        billingAddress: details.billingAddress.trim(),
        billingCountry: country,
        billingEmail: details.billingEmail.trim(),
      },
      payload: z.unknown(),
      raw: true,
    });
    revalidatePath('/[locale]/settings/billing', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('billing.profile_save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'invalid_country' };
      if (cause.status === 409) return { ok: false, reason: 'no_record' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type CardSessionResult =
  | { readonly ok: true; readonly redirectUrl: string; readonly sessionId: string }
  | {
      readonly ok: false;
      readonly reason: 'held' | 'unavailable' | 'no_account' | 'forbidden' | 'failed';
    };

/**
 * 17e's Add / Replace card: a session on the provider's hosted page. It
 * creates a client at the provider - so it refuses first when billing writes
 * are off (BILLING_WRITES, fail closed), before any request.
 */
export async function startCardSession(): Promise<CardSessionResult> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    const page = await serverApi().post({
      endpoint: billingEndpoints.paymentMethodSession(),
      /*
       * Back to v2 (billing d0824153): success to <origin>/v2/settings/billing/
       * payment-method, failure and cancel to the same with ?cancelled=1 - no
       * locale (v2's routing adds the reader's), no id in the URL.
       */
      body: { returnTo: 'v2' },
      payload: z.object({ redirectUrl: z.string().min(1), sessionId: z.string().min(1) }),
    });
    // Only ever a secure page: anything else is not where a card is typed.
    if (!URL.canParse(page.redirectUrl) || new URL(page.redirectUrl).protocol !== 'https:') {
      logger.warn('billing.card_session_bad_url');
      return { ok: false, reason: 'failed' };
    }
    return { ok: true, redirectUrl: page.redirectUrl, sessionId: page.sessionId };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('billing.card_session_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 409)
        return {
          ok: false,
          reason: cause.developerMessage === 'no_billable_entity' ? 'no_account' : 'unavailable',
        };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type CardConfirmResult =
  | {
      readonly ok: true;
      readonly status: 'STORED';
      readonly card: { readonly brand: string | null; readonly last4: string | null };
    }
  | {
      readonly ok: true;
      readonly status: 'PENDING';
      readonly reason: 'no_new_card_yet' | 'expired' | 'exhausted' | 'already_failed' | 'unknown';
    }
  | {
      readonly ok: false;
      readonly reason: 'held' | 'not_found' | 'unavailable' | 'forbidden' | 'failed';
    };

const PENDING_REASONS = ['no_new_card_yet', 'expired', 'exhausted', 'already_failed'] as const;

/**
 * Back from the hosted page: did a card arrive? The provider is asked, so
 * this too refuses first when billing writes are off.
 */
export async function confirmCardSession(sessionId: string): Promise<CardConfirmResult> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  if (!sessionId) return { ok: false, reason: 'not_found' };
  try {
    const answer = await serverApi().post({
      endpoint: billingEndpoints.paymentMethodConfirm(),
      body: { sessionId },
      payload: z.object({
        status: z.string(),
        reason: z.string().nullable().catch(null).default(null),
        paymentMethod: z
          .object({
            brand: z.string().nullable().catch(null).default(null),
            last4: z.string().nullable().catch(null).default(null),
          })
          .nullable()
          .catch(null)
          .default(null),
      }),
    });
    if (answer.status === 'STORED') {
      revalidatePath('/[locale]/settings/billing', 'page');
      return {
        ok: true,
        status: 'STORED',
        card: answer.paymentMethod ?? { brand: null, last4: null },
      };
    }
    const reason = (PENDING_REASONS as readonly string[]).includes(answer.reason ?? '')
      ? (answer.reason as (typeof PENDING_REASONS)[number])
      : 'unknown';
    return { ok: true, status: 'PENDING', reason };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('billing.card_confirm_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 409) return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export interface AutoPurchaseInput {
  readonly enabled: boolean;
  readonly thresholdPct: number;
  readonly packageKey: string | null;
  /** A decimal string; null is "no monthly limit" - said so, never by omission. */
  readonly maxMonthlySpend: string | null;
  readonly limitBehavior: 'STOP_AI' | 'HUMAN_ONLY' | 'REQUIRE_APPROVAL' | 'PREPAID_ONLY';
  /* Sent back as stored - the route writes every field and nulls what it is not sent. */
  readonly warningThresholdPct: number;
  readonly incrementCredits: number | null;
  readonly pricePerCredit: string | null;
}

export type AutoPurchaseResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'held' | 'plan' | 'invalid' | 'forbidden' | 'failed';
    };

/**
 * 17c's Save - `PUT /billing/auto-purchase`. Database only, but turning it
 * on ARMS charges on the stored card, so it refuses first when billing writes
 * are off (BILLING_WRITES, fail closed), before any request. 402 is a plan
 * that does not allow automatic purchases (PLAN_FEATURE_REQUIRED).
 */
export async function saveAutoPurchase(input: AutoPurchaseInput): Promise<AutoPurchaseResult> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    await serverApi().put({
      endpoint: billingEndpoints.autoPurchase(),
      body: {
        enabled: input.enabled,
        thresholdPct: input.thresholdPct,
        packageKey: input.packageKey,
        maxMonthlySpend: input.maxMonthlySpend,
        limitBehavior: input.limitBehavior,
        warningThresholdPct: input.warningThresholdPct,
        incrementCredits: input.incrementCredits,
        pricePerCredit: input.pricePerCredit,
      },
      payload: z.unknown(),
      raw: true,
    });
    revalidatePath('/[locale]/settings/billing', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('billing.auto_purchase_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 402) return { ok: false, reason: 'plan' };
      if (cause.status === 400) return { ok: false, reason: 'invalid' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type PreviewResult =
  | { readonly ok: true; readonly preview: PlanChangePreview }
  | { readonly ok: false; readonly reason: 'held' | 'not_selectable' | 'forbidden' | 'failed' };

/**
 * 17b: what switching to `planKey` would do and charge - the server's exact
 * figure. No write and no provider call, but it is half of a charge, so it
 * stays behind BILLING_WRITES with the change itself.
 */
export async function previewPlanChange(planKey: string): Promise<PreviewResult> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    const preview = await serverApi().post({
      endpoint: billingEndpoints.changePlanPreview(),
      body: { planKey },
      payload: planChangePreviewSchema,
      raw: true,
    });
    return { ok: true, preview };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('billing.plan_preview_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'not_selectable' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type ChangePlanResult =
  | {
      readonly ok: true;
      readonly applied: 'immediate' | 'scheduled';
      readonly effectiveAt: string | null;
    }
  | {
      readonly ok: false;
      /**
       * `moved` - the figure changed since the confirm; nothing was charged
       * (409). `unknown` - the charge's outcome is not known, so it may have
       * gone through: never "failed", never "try again" - the same rule as
       * buy credits' `unsettled`. A request that never got an answer is
       * `unknown` too. `declined` - the provider said no; nothing charged.
       */
      readonly reason:
        'held' | 'moved' | 'no_card' | 'declined' | 'unknown' | 'not_selectable' | 'forbidden';
    };

/**
 * 17b: switch plans - charging exactly the figure the person confirmed. Both
 * expected values are always sent; null when nothing is charged now.
 */
export async function changePlanTo(
  planKey: string,
  expected: { readonly gross: string | null; readonly fxRateVersion: number | null },
): Promise<ChangePlanResult> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    const done = await serverApi().post({
      endpoint: billingEndpoints.changePlan(),
      body: {
        planKey,
        expectedChargeAmount: expected.gross,
        expectedFxRateVersion: expected.fxRateVersion,
      },
      payload: planChangeResultSchema,
      raw: true,
    });
    revalidatePath('/[locale]/settings/billing', 'layout');
    return { ok: true, applied: done.applied, effectiveAt: done.effectiveAt };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('billing.change_plan_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (!isApiError(cause) || cause.status === undefined || cause.status >= 500) {
      // No answer, or the service broke mid-way: whether it charged is not known.
      return { ok: false, reason: 'unknown' };
    }
    const code = cause.developerMessage ?? '';
    if (cause.status === 409 && code === 'charge_amount_changed')
      return { ok: false, reason: 'moved' };
    if (code === 'upgrade_payment_outcome_unknown') return { ok: false, reason: 'unknown' };
    if (code === 'payment_method_required') return { ok: false, reason: 'no_card' };
    if (code.startsWith('upgrade_payment_failed:')) return { ok: false, reason: 'declined' };
    if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'not_selectable' };
  }
}
