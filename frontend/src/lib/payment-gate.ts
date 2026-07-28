/**
 * Where a customer belongs when their organization has not paid.
 *
 * A paid tenant has two front doors and only one of them asks for money. The
 * payment link goes to /checkout; the onboarding email carries an Authentik
 * setup link that lands the customer authenticated in /setup. Whichever door
 * they came through, an organization in PENDING_PAYMENT has to end up at the
 * payment screen - which is exactly what did not happen: the customer created
 * their account, landed in setup, and never saw a payment page.
 *
 * The decision is NOT made here. `evaluateTenantAccess` in the shared package
 * already answers 402 TENANT_PAYMENT_REQUIRED with a `redirectPath`, and the
 * paid product is refused at the API whatever this file does. This module only
 * makes the browser obey an answer the server has already given, so the two can
 * never disagree about who owes money.
 */

import { getMyCheckout } from "@/lib/api-checkout";

/** The server's own name for "this organization has not paid". */
export const PAYMENT_REQUIRED_CODE = "TENANT_PAYMENT_REQUIRED";

/** The page that asks for payment. Matches the policy's `redirectPath`. */
export const PAYMENT_REQUIRED_PATH = "/checkout/payment-required";

/**
 * Read a thrown API error and decide whether it was a payment refusal.
 *
 * Only a 402 carrying the policy's own code counts. A 402 from anywhere else,
 * or a 403 that happens to mention payment, is not treated as one - guessing
 * would send someone to a checkout that does not concern them.
 */
export function isPaymentRequiredError(err: unknown): boolean {
  const e = err as { status?: number; body?: { code?: string } } | null;
  return e?.status === 402 && e?.body?.code === PAYMENT_REQUIRED_CODE;
}

/**
 * The URL to send an unpaid customer to.
 *
 * Resolves the organization's outstanding checkout so the page opens on the
 * right one. When there is no resolvable checkout - none issued, or the offer
 * expired - it falls back to the checkout entry point, which explains the
 * situation rather than rendering a payment screen with nothing to pay for.
 *
 * Only the opaque reference travels. No tenant id, no token.
 */
export async function paymentRedirectTarget(authToken: string | null): Promise<string> {
  try {
    const checkout = await getMyCheckout({ authToken });
    if (checkout?.reference) {
      return `${PAYMENT_REQUIRED_PATH}?ref=${encodeURIComponent(checkout.reference)}`;
    }
  } catch {
    // An unreachable billing service must not strand the customer on a page
    // the API is refusing anyway. The entry page states what is known.
  }
  return "/checkout";
}

/**
 * Where an authenticated customer belongs, given their organization's status.
 *
 * `null` means "leave them where they are". Anything else is a path to replace
 * the current route with.
 *
 * PENDING_PAYMENT is checked BEFORE the generic not-yet-active rule, because
 * the old rule sent every non-active tenant to /setup - including the ones that
 * owed money, which is precisely how setup became a way around paying.
 */
export async function destinationForTenantStatus(
  status: string,
  opts: { authToken: string | null; pathname: string },
): Promise<string | null> {
  if (status === "PENDING_PAYMENT") {
    // Already somewhere in checkout: the checkout pages route among themselves
    // from the server's status, and second-guessing them here would fight the
    // dispatcher.
    if (opts.pathname.startsWith("/checkout")) return null;
    return paymentRedirectTarget(opts.authToken);
  }

  if (status !== "ACTIVE") {
    return opts.pathname.startsWith("/setup") ? null : "/setup";
  }

  return null;
}
