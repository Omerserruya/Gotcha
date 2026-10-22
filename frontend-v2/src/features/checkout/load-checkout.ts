import 'server-only';

import { cookies } from 'next/headers';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { platformHeaders, serverApi } from '@/api/client/server-api';
import { checkoutSummarySchema, type CheckoutSummary } from '@/api/contracts/checkout';
import { checkoutEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Reading a checkout, as whoever is holding it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ TWO WAYS IN, AND THE TOKEN DECIDES ALONE WHEN IT IS SENT
 * ════════════════════════════════════════════════════════════════════════════
 * Billing admits the emailed continuation token, or a session whose user
 * belongs to the checkout's tenant (`lib/checkout-auth.ts`). But a token that
 * is sent and no longer resolves is a refusal on its own - the session is
 * never consulted (`checkout-auth.ts:111-135`). So a member holding a spent
 * token would be told the link is gone while their session could read it:
 * a refusal WITH the token is asked once more without it.
 *
 * The token arrives in the email's URL and is kept from then on in an
 * HttpOnly cookie this app sets (`openCheckout`) - the value and lifetime
 * billing itself hands the browser, so nothing script-readable holds it and
 * it dies with the link. Our server sends it on as `?token=` / `{ token }`.
 */

/** Our cookie for one checkout's token. Per reference, so one never opens another. */
export function tokenCookieName(reference: string): string {
  return `gotcha_co_${reference.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** Billing's own cookie name for it (`checkout-auth.ts:30`), read off its `Set-Cookie`. */
export function billingCookieName(reference: string): string {
  return `gc_co_${reference.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** The token this browser holds for the checkout, if any. */
export async function heldToken(reference: string): Promise<string | null> {
  return (await cookies()).get(tokenCookieName(reference))?.value || null;
}

/**
 * Ask as the token holder, then - only on billing's uniform 404 - as the
 * session. Any other failure is the answer.
 */
export async function asHolder<T>(
  reference: string,
  call: (token: string | null) => Promise<T>,
  token?: string | null,
): Promise<T> {
  const held = token ?? (await heldToken(reference));
  if (!held) return call(null);
  try {
    return await call(held);
  } catch (cause) {
    if (isApiError(cause) && cause.status === 404 && (await signedIn())) return call(null);
    throw cause;
  }
}

export type CheckoutRead =
  | { readonly kind: 'ready'; readonly summary: CheckoutSummary }
  /** A wrong, spent or foreign link - deliberately one state, whatever the cause. */
  | { readonly kind: 'unavailable' };

export function statusRequest(reference: string, token: string | null) {
  return {
    endpoint: checkoutEndpoints.status(reference),
    payload: checkoutSummarySchema,
    ...(token ? { query: { token } } : {}),
  } as const;
}

/** The safe summary, or `unavailable`. Never throws. */
export async function loadCheckout(reference: string | null): Promise<CheckoutRead> {
  if (!reference) return { kind: 'unavailable' };
  try {
    const summary = await asHolder(reference, (token) =>
      serverApi().get(statusRequest(reference, token)),
    );
    return { kind: 'ready', summary };
  } catch (cause) {
    if (!(isApiError(cause) && cause.status === 404)) {
      logger.warn('checkout.status_failed', {
        status: isApiError(cause) ? cause.status : undefined,
      });
    }
    return { kind: 'unavailable' };
  }
}

export type MineRead =
  | { readonly kind: 'open'; readonly reference: string }
  /** The offer ran out; it is not reissued automatically (`checkout.ts:206`). */
  | { readonly kind: 'expired' }
  | { readonly kind: 'none' };

const mineSchema = z.object({
  data: z.looseObject({
    checkout: z.looseObject({ reference: z.string() }).nullable().catch(null),
    expired: z.boolean().catch(false).default(false),
  }),
});

/**
 * A signed-in member's own outstanding checkout (`GET /api/checkout/mine`,
 * `checkout.ts:183`): how someone who lost the email, or came from the
 * product's payment gate with no reference, still reaches payment. Signed
 * out, there is nobody to ask about.
 */
export async function loadMine(): Promise<MineRead> {
  if (!(await signedIn())) return { kind: 'none' };
  try {
    const mine = await serverApi().get({
      endpoint: checkoutEndpoints.mine(),
      payload: mineSchema,
      raw: true,
    });
    const reference = mine.data.checkout?.reference;
    if (reference) return { kind: 'open', reference };
    return mine.data.expired ? { kind: 'expired' } : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/**
 * Whether this request carries a session - the platform's own cookie or this
 * app's - read from the very headers a call would send, so "signed in" here
 * and the credential billing sees cannot disagree.
 */
async function signedIn(): Promise<boolean> {
  const headers = await platformHeaders();
  return 'authorization' in headers || 'cookie' in headers;
}
