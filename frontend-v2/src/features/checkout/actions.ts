'use server';

import { cookies } from 'next/headers';

import { isApiError } from '@/api/client/api-error';
import { billingWritesEnabled } from '@/api/client/billing-writes';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  advanceSchema,
  paymentSessionSchema,
  resendWelcomeSchema,
  type CheckoutSummary,
} from '@/api/contracts/checkout';
import { checkoutEndpoints } from '@/api/endpoints/registry';
import { cookieFrom } from '@/features/capabilities/shopify-cookies';
import { appPath } from '@/lib/base-path';
import { logger } from '@/observability/logger';

import { pageForStatus, referenceFrom, type CheckoutPage } from './checkout-pages';
import {
  asHolder,
  billingCookieName,
  loadCheckout,
  statusRequest,
  tokenCookieName,
} from './load-checkout';

/*
  Every catch below hands a 401 to sign-in, as every action does. Billing
  answers one only when this request carried a session it refused
  (`optionalAuth` → `authenticate`); a payer with no session, holding only
  the emailed token, is never sent there - an unknown or foreign checkout is
  the uniform 404.
*/

/**
 * The emailed link's first hop: prove the token on billing, keep it in an
 * HttpOnly cookie, and say which page the checkout belongs on. The page has
 * already taken the token out of the address bar.
 *
 * Kept only when billing itself hands the browser a cookie for it - that is
 * billing's word that the token resolved, and its `Max-Age` is the link's
 * own expiry, so ours never outlives the offer.
 */
export async function openCheckout(
  reference: string,
  token: string,
): Promise<{ readonly ok: true; readonly page: CheckoutPage } | { readonly ok: false }> {
  const ref = referenceFrom(reference);
  if (!ref || !token) return { ok: false };
  let relayed: ReturnType<typeof cookieFrom> = null;
  try {
    const summary = await serverApi().get({
      ...statusRequest(ref, token),
      onResponseHeaders: (headers) => {
        relayed = cookieFrom(headers.getSetCookie(), billingCookieName(ref));
      },
    });
    const kept = relayed as ReturnType<typeof cookieFrom>;
    if (kept) {
      (await cookies()).set(tokenCookieName(ref), kept.value, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: appPath('/'),
        ...(kept.maxAge === undefined ? {} : { maxAge: kept.maxAge }),
      });
    }
    return { ok: true, page: pageForStatus(summary.status) };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (!(isApiError(cause) && cause.status === 404)) {
      logger.warn('checkout.open_failed', { status: isApiError(cause) ? cause.status : undefined });
    }
    return { ok: false };
  }
}

export type PaymentStart =
  | { readonly ok: true; readonly url: string }
  /** Billing writes are off for this deployment (BILLING_WRITES, fail closed). */
  | { readonly ok: false; readonly kind: 'held' }
  | { readonly ok: false; readonly kind: 'failed' };

/**
 * "Set up payment": billing starts (or resumes) the provider's hosted card
 * page and answers where to send the customer. The destination is billing's,
 * never ours - and it must be https.
 *
 * ★ A WRITE AT THE PROVIDER. Dev's billing is the live payment account, so
 * this refuses before any request unless `BILLING_WRITES=on`.
 */
export async function startCheckoutPayment(reference: string): Promise<PaymentStart> {
  if (!billingWritesEnabled()) return { ok: false, kind: 'held' };
  const ref = referenceFrom(reference);
  if (!ref) return { ok: false, kind: 'failed' };
  try {
    const { redirectUrl } = await asHolder(ref, (token) =>
      serverApi().post({
        endpoint: checkoutEndpoints.paymentSession(ref),
        payload: paymentSessionSchema,
        body: token ? { token } : {},
      }),
    );
    if (new URL(redirectUrl).protocol !== 'https:') return { ok: false, kind: 'failed' };
    return { ok: true, url: redirectUrl };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('checkout.payment_session_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, kind: 'failed' };
  }
}

export type CheckoutWatch =
  { readonly kind: 'ready'; readonly summary: CheckoutSummary } | { readonly kind: 'unavailable' };

/**
 * The waiting page's poll: ask billing to re-check with the provider, then
 * read where things stand. Sends no outcome - billing decides - so this
 * cannot make a checkout succeed by claiming it did.
 *
 * ★ `advance` MAY CHARGE the stored card, so it runs only with
 * `BILLING_WRITES=on`; held, the poll only reads. A failed advance is not
 * fatal: the read still says where things stand.
 */
export async function watchCheckout(reference: string): Promise<CheckoutWatch> {
  const ref = referenceFrom(reference);
  if (!ref) return { kind: 'unavailable' };
  if (billingWritesEnabled()) {
    try {
      await asHolder(ref, (token) =>
        serverApi().post({
          endpoint: checkoutEndpoints.advance(ref),
          payload: advanceSchema,
          body: token ? { token } : {},
        }),
      );
    } catch (cause) {
      await signInIfSignedOut(cause);
      logger.warn('checkout.advance_failed', {
        status: isApiError(cause) ? cause.status : undefined,
      });
    }
  }
  return loadCheckout(ref);
}

/**
 * The welcome email again, once paid: for an admin whose invoice someone
 * else paid, it is the only thing carrying a way to set a password. Billing
 * echoes no address and no link - only whether something was posted.
 */
export async function resendWelcome(reference: string): Promise<{ readonly sent: boolean }> {
  const ref = referenceFrom(reference);
  if (!ref) return { sent: false };
  try {
    return await asHolder(ref, (token) =>
      serverApi().post({
        endpoint: checkoutEndpoints.resendWelcome(ref),
        payload: resendWelcomeSchema,
        body: token ? { token } : {},
      }),
    );
  } catch (cause) {
    await signInIfSignedOut(cause);
    return { sent: false };
  }
}
