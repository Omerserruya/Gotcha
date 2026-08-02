/**
 * Driving a checkout forward.
 *
 * The customer's browser can ask us to look again. It cannot tell us what it
 * found. Every transition here is decided from server-side facts: what the
 * provider says about the stored card, and what our own charge attempt
 * recorded. A request from a browser is a prompt to re-check, never evidence.
 *
 * That distinction is the entire reason this is a service rather than a route
 * handler that reads a success flag off a redirect.
 */
import { prisma } from "@chatcenter/shared";
import type { PendingCheckout } from "@prisma/client";
import { executeCharge } from "./charge-execution.service";
import {
  resumeTokenizationSession,
  sessionForCheckout,
  startTokenizationSession,
  verifyTokenizationSession,
} from "./tokenization.service";
import { activatePaidCheckout } from "./checkout-activation.service";
import { chargingRateConfigured } from "./exchange-rate.service";
import { getCapabilities } from "../providers";
import { assertCheckoutMayBeEnabled, CheckoutDisabledError } from "./checkout.service";
import { PaymentCapabilityDisabledError } from "../providers/icount-config";

export class CheckoutProgressRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] checkout cannot proceed: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "CheckoutProgressRefused";
  }
}

export interface PaymentSetupResult {
  /** Where to send the customer. */
  redirectUrl: string;
  sessionId: string;
}

/**
 * Begin, or resume, payment setup.
 *
 * Resumes rather than restarts when a session is already open. Starting a fresh
 * one on every click would leave a trail of half-finished sessions and, worse,
 * a new baseline that no longer reflects what the customer already did.
 */
export async function startPaymentSetup(
  reference: string,
  opts: { successUrl?: string; failureUrl?: string; cancelUrl?: string } = {},
): Promise<PaymentSetupResult> {
  const checkout = await requireOpenCheckout(reference);

  try {
    // One statement of the rule, in checkout.service, actually invoked. It used
    // to be defined there and checked separately here, which left the guard
    // unused and its message free to drift out of date - it still claimed
    // checkout was disabled long after it had been enabled.
    assertCheckoutMayBeEnabled(getCapabilities("ICOUNT"));
  } catch (err) {
    if (err instanceof CheckoutDisabledError) {
      throw new CheckoutProgressRefused(err.code);
    }
    // A switched-off capability is a refusal, not a fault. Letting it escape
    // here would surface as a 500, which reads as "we are broken" to a customer
    // and sends an operator looking for an outage that is not happening.
    if (err instanceof PaymentCapabilityDisabledError) {
      throw new CheckoutProgressRefused("payment_setup_unavailable");
    }
    throw err;
  }
  // Refuse before sending anyone to a payment page we could not then charge
  // against. Discovering that after they enter card details would be worse.
  if (!(await chargingRateConfigured())) {
    throw new CheckoutProgressRefused("charging_rate_not_configured");
  }

  const existing = await sessionForCheckout(checkout.id);
  if (existing && existing.status !== "VERIFIED") {
    // Genuinely resume: a fresh URL against the SAME customer reference. This
    // used to start a whole new session, which meant a second click minted a
    // new reference - so a customer who had already entered their card against
    // the first one was stranded, because their card existed and we were
    // looking somewhere else for it.
    const redirectUrl = await resumeTokenizationSession(existing, opts);
    return { redirectUrl, sessionId: existing.id };
  }

  const started = await startTokenizationSession({
    tenantId: checkout.tenantId!,
    checkoutId: checkout.id,
    successUrl: opts.successUrl,
    failureUrl: opts.failureUrl,
    cancelUrl: opts.cancelUrl,
    // The opaque checkout reference, never a database id.
    orderId: checkout.reference,
  });

  await prisma.pendingCheckout.update({
    where: { id: checkout.id },
    data: { status: "AWAITING_PROVIDER" },
  });

  return { redirectUrl: started.saleUrl, sessionId: started.session.id };
}

export type AdvanceResult =
  | { phase: "AWAITING_CARD" }
  | { phase: "CHARGING" }
  | { phase: "PAID"; firstActivation: boolean }
  | { phase: "PAYMENT_FAILED"; failureCode?: string }
  | { phase: "NEEDS_ATTENTION"; reason: string };

/**
 * Re-check a checkout and move it as far as the facts allow.
 *
 * Safe to call repeatedly - that is how the waiting page works. Each step is
 * individually idempotent, so a customer refreshing during a charge cannot
 * cause a second one.
 */
export async function advanceCheckout(reference: string): Promise<AdvanceResult> {
  const checkout = await prisma.pendingCheckout.findUnique({ where: { reference } });
  if (!checkout) throw new CheckoutProgressRefused("checkout_not_found");
  if (checkout.status === "PAID") return { phase: "PAID", firstActivation: false };
  // Stated here rather than relied upon from the link resolver, which now
  // authorizes viewing a finished checkout so the customer can see what
  // happened. Advancing one must still be impossible.
  if (checkout.status === "CANCELED") throw new CheckoutProgressRefused("checkout_canceled");
  if (checkout.status === "EXPIRED" || checkout.expiresAt <= new Date()) {
    throw new CheckoutProgressRefused("checkout_expired");
  }
  if (!checkout.tenantId) throw new CheckoutProgressRefused("checkout_has_no_tenant");

  // A charge that already succeeded wins over everything else, including a
  // later failed retry. Reconciliation can turn an older UNKNOWN into SUCCEEDED
  // after a newer attempt has already failed, so "the most recent attempt" is
  // the wrong question to ask - "did any of them work" is the right one.
  const succeeded = await prisma.paymentAttempt.findFirst({
    where: { checkoutId: checkout.id, state: "SUCCEEDED" },
    orderBy: { createdAt: "asc" },
  });

  // An attempt whose outcome we cannot act on. Surfacing it as a failure would
  // invite a retry; a retry here can charge twice.
  const unresolved = succeeded
    ? null
    : await prisma.paymentAttempt.findFirst({
        where: {
          checkoutId: checkout.id,
          state: { in: ["UNKNOWN", "RECONCILIATION_REQUIRED", "MANUAL_REVIEW"] },
        },
        orderBy: { createdAt: "desc" },
      });
  if (unresolved) return { phase: "NEEDS_ATTENTION", reason: unresolved.state };

  // Activate straight away rather than looking at the card again - the money is
  // already in, and re-verifying tokenization would only be a way to fail.
  if (succeeded) return activate(checkout, succeeded.id);

  const session = await sessionForCheckout(checkout.id);
  if (!session) return { phase: "AWAITING_CARD" };

  const verified = await verifyTokenizationSession(session.id);
  if (!verified.verified) return { phase: "AWAITING_CARD" };

  const charge = await executeCharge({
    // Derived from the checkout, so every retry is the SAME logical charge.
    attemptKey: `checkout:${checkout.reference}`,
    purpose: "SUBSCRIPTION_INITIAL",
    tenantId: checkout.tenantId,
    checkoutId: checkout.id,
    commercialAmount: checkout.snapshotPrice,
    commercialCurrency: checkout.snapshotCurrency,
    description: `${checkout.planKey} subscription`,
    paymentMethodId: verified.paymentMethodId,
    customClientId: session.customClientId,
    providerCustomerId: session.providerClientId ?? undefined,
    issueInvoice: true,
  });

  if (charge.state === "SUCCEEDED") return activate(checkout, charge.attemptId);
  if (charge.state === "FAILED") {
    await prisma.pendingCheckout
      .update({ where: { id: checkout.id }, data: { status: "PENDING" } })
      .catch(() => {});
    return { phase: "PAYMENT_FAILED", failureCode: charge.failureCode };
  }
  if (charge.state === "PENDING") return { phase: "CHARGING" };
  return { phase: "NEEDS_ATTENTION", reason: charge.state };
}

async function activate(checkout: PendingCheckout, attemptId: string): Promise<AdvanceResult> {
  const res = await activatePaidCheckout({ checkoutId: checkout.id, paymentAttemptId: attemptId });
  return { phase: "PAID", firstActivation: res.firstActivation };
}

async function requireOpenCheckout(reference: string): Promise<PendingCheckout> {
  const checkout = await prisma.pendingCheckout.findUnique({ where: { reference } });
  if (!checkout) throw new CheckoutProgressRefused("checkout_not_found");
  if (!checkout.tenantId) throw new CheckoutProgressRefused("checkout_has_no_tenant");
  if (checkout.status === "PAID") throw new CheckoutProgressRefused("checkout_already_paid");
  if (checkout.status === "CANCELED") throw new CheckoutProgressRefused("checkout_canceled");
  if (checkout.status === "EXPIRED" || checkout.expiresAt <= new Date()) {
    throw new CheckoutProgressRefused("checkout_expired");
  }
  return checkout;
}
