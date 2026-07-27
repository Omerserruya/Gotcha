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
import { checkoutEnabled } from "../providers/capabilities";
import { getCapabilities } from "../providers";

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
  opts: { successUrl?: string; failureUrl?: string } = {},
): Promise<PaymentSetupResult> {
  const checkout = await requireOpenCheckout(reference);

  if (!checkoutEnabled(getCapabilities("ICOUNT"))) {
    throw new CheckoutProgressRefused("payment_setup_unavailable");
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
  if (!checkout.tenantId) throw new CheckoutProgressRefused("checkout_has_no_tenant");

  // An attempt already exists whose outcome we cannot act on. Surfacing it as a
  // failure would invite a retry; a retry here can charge twice.
  const prior = await prisma.paymentAttempt.findFirst({
    where: { checkoutId: checkout.id },
    orderBy: { createdAt: "desc" },
  });
  if (prior && (prior.state === "UNKNOWN" || prior.state === "RECONCILIATION_REQUIRED" || prior.state === "MANUAL_REVIEW")) {
    return { phase: "NEEDS_ATTENTION", reason: prior.state };
  }

  const session = await sessionForCheckout(checkout.id);
  if (!session) return { phase: "AWAITING_CARD" };

  const verified = await verifyTokenizationSession(session.id);
  if (!verified.verified) return { phase: "AWAITING_CARD" };

  // The card exists. If a charge already succeeded, skip straight to
  // activation rather than charging again.
  if (prior?.state === "SUCCEEDED") {
    return activate(checkout, prior.id);
  }

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
