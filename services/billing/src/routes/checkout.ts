/**
 * Customer-facing checkout status.
 *
 * Two rules shape this file:
 *
 *   1. Knowing the opaque reference is NOT authorization. The reference travels
 *      through a browser URL and a third party, so it identifies a checkout but
 *      proves nothing about who is asking. A caller must ALSO present a valid
 *      continuation link, a session with membership in the bound tenant, or
 *      platform admin rights.
 *
 *   2. Nothing here can complete a checkout. Every handler is a read. A browser
 *      returning from a payment page tells us the customer came back, never
 *      that they paid - that answer comes from verified server-side processing.
 */
import { Router } from "express";
import { prisma } from "@chatcenter/shared";
import { checkoutEnabled } from "../providers/capabilities";
import { getCapabilities } from "../providers";
import { activeRate, convert } from "../services/exchange-rate.service";
import { quoteDisplay } from "../services/payment-quote.service";
// Shared with the mutating session routes, so the two cannot drift apart about
// who is allowed to act on a checkout.
import { authorizeCheckout as authorize, checkoutNotFound as notFound, optionalAuth } from "../lib/checkout-auth";

const router = Router();

/** Coarse per-reference limiter, so a leaked reference cannot be polled hard. */
const POLLS = new Map<string, { count: number; resetAt: number }>();
const POLL_LIMIT = 60;
const POLL_WINDOW_MS = 60_000;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hit = POLLS.get(key);
  if (!hit || hit.resetAt < now) {
    POLLS.set(key, { count: 1, resetAt: now + POLL_WINDOW_MS });
    return false;
  }
  hit.count += 1;
  return hit.count > POLL_LIMIT;
}

/**
 * The safe, customer-facing status.
 *
 * Deliberately NOT the raw enum: internal states like TOKENIZED or
 * AWAITING_PROVIDER describe our plumbing, and a customer needs to know what to
 * do rather than where their record sits in our state machine.
 */
type SafeStatus =
  | "AWAITING_PAYMENT_SETUP"
  | "PROCESSING"
  | "PAYMENT_REQUIRED"
  | "FAILED"
  | "EXPIRED"
  | "COMPLETED"
  | "MANUAL_REVIEW";

function safeStatus(
  checkout: { status: string; expiresAt: Date },
  attemptState?: string | null,
  sessionStatus?: string | null,
): SafeStatus {
  if (checkout.status === "PAID") return "COMPLETED";
  if (checkout.status === "CANCELED") return "EXPIRED";
  if (checkout.status === "EXPIRED" || checkout.expiresAt.getTime() <= Date.now()) return "EXPIRED";
  if (checkout.status === "FAILED") return "FAILED";

  // An attempt whose outcome we cannot determine is NOT a failure the customer
  // should retry - retrying might charge them twice.
  if (attemptState === "UNKNOWN" || attemptState === "RECONCILIATION_REQUIRED") return "PROCESSING";
  if (attemptState === "MANUAL_REVIEW") return "MANUAL_REVIEW";
  if (attemptState === "PENDING" && checkout.status === "TOKENIZED") return "PROCESSING";
  if (attemptState === "FAILED") return "PAYMENT_REQUIRED";

  // A payment session is open, so the customer has been sent to the hosted page
  // and may be on their way back. Without this they would land on the return
  // URL, be told payment was still required, and reasonably conclude they had
  // to pay again.
  if (sessionStatus === "PENDING" || sessionStatus === "AWAITING_RETURN" || sessionStatus === "VERIFIED") {
    return "PROCESSING";
  }
  // An abandoned or expired session is not "processing" - nothing is in
  // flight, and leaving them watching a spinner forever would be worse than
  // asking them to start again.

  return "AWAITING_PAYMENT_SETUP";
}

/** What the customer should do next, in our words rather than a state name. */
function nextAction(status: SafeStatus, providerReady: boolean): string {
  switch (status) {
    case "COMPLETED": return "CONTINUE_TO_APP";
    case "EXPIRED": return "REQUEST_NEW_LINK";
    case "PROCESSING": return "WAIT";
    case "MANUAL_REVIEW": return "CONTACT_SUPPORT";
    case "FAILED":
    case "PAYMENT_REQUIRED":
    case "AWAITING_PAYMENT_SETUP":
    default:
      return providerReady ? "START_PAYMENT_SETUP" : "PAYMENT_SETUP_UNAVAILABLE";
  }
}


/**
 * The ILS figures, and whether they are settled or still indicative.
 *
 * Before payment there is no frozen quote yet, so the conversion is shown at
 * the currently approved rate and marked as such - it is what WILL be used, not
 * a promise that nothing changes in between. After payment the frozen quote is
 * authoritative and is shown exactly.
 *
 * Returns null when no rate is approved, so the UI can say charging is
 * unavailable rather than displaying a number it made up.
 */
async function chargeFigures(checkout: { id: string; snapshotPrice: any; snapshotCurrency: string }) {
  const settled = await prisma.paymentQuote.findFirst({
    where: { checkoutId: checkout.id, status: "CONSUMED" },
    orderBy: { createdAt: "desc" },
  });
  if (settled) {
    const d = quoteDisplay(settled);
    return {
      amount: d.chargeAmount,
      currency: d.chargeCurrency,
      exchangeRate: d.fxRate,
      settled: true,
    };
  }

  try {
    const rate = await activeRate({
      base: checkout.snapshotCurrency,
      quote: "ILS",
      now: new Date(),
    });
    return {
      amount: convert(checkout.snapshotPrice, rate.rate).toFixed(2),
      currency: "ILS",
      exchangeRate: Number(rate.rate).toFixed(4),
      settled: false,
    };
  } catch {
    // Identity case: an ILS-priced plan needs no conversion.
    if (String(checkout.snapshotCurrency).toUpperCase() === "ILS") {
      return {
        amount: Number(checkout.snapshotPrice).toFixed(2),
        currency: "ILS",
        exchangeRate: "1.0000",
        settled: false,
      };
    }
    return null;
  }
}

/**
 * Safe summary + status.
 *
 * Optional authentication: a customer arriving from an email has a continuation
 * token and no session, while a signed-in user has the reverse.
 */
router.get("/checkout/:reference/status", optionalAuth, async (req, res) => {
  const reference = String(req.params.reference || "");
  if (!reference.startsWith("chk_")) return notFound(res);
  if (rateLimited(reference)) return res.status(429).json({ error: "rate_limited" });

  const checkout = await prisma.pendingCheckout.findUnique({ where: { reference } });
  if (!checkout) return notFound(res);

  const auth = await authorize(req, checkout);
  // Same response as a missing checkout: an unauthorized caller learns nothing
  // about whether the reference was real.
  if (!auth.ok) return notFound(res);

  const attempt = await prisma.paymentAttempt.findFirst({
    where: { checkoutId: checkout.id },
    orderBy: { createdAt: "desc" },
    select: { state: true },
  });

  const tenant = checkout.tenantId
    ? await prisma.tenant.findUnique({ where: { id: checkout.tenantId }, select: { name: true } })
    : null;

  const plan = await prisma.plan.findFirst({
    where: { key: checkout.planKey, version: checkout.planVersion },
    select: { name: true },
  });

  const session = await prisma.tokenizationSession.findFirst({
    where: { checkoutId: checkout.id },
    orderBy: { createdAt: "desc" },
    select: { status: true, expiresAt: true },
  });
  // Expiry is enforced on read here too: a session past its deadline is not an
  // open one, whatever its stored status still says.
  const liveSession = session && session.expiresAt > new Date() ? session.status : null;

  const providerReady = checkoutEnabled(getCapabilities("ICOUNT"));
  const status = safeStatus(checkout, attempt?.state, liveSession);
  const charge = await chargeFigures(checkout);

  // Every field here is customer-safe. No token, page id, provider customer id,
  // transaction id, attempt key, internal tenant id or raw provider payload.
  res.json({
    data: {
      reference: checkout.reference,
      organizationName: tenant?.name ?? null,
      planName: plan?.name ?? checkout.planKey,
      chatVolumeOptionKey: checkout.chatVolumeOptionKey,
      voiceVolumeOptionKey: checkout.voiceVolumeOptionKey,
      includedCredits: checkout.snapshotIncludedCredits,
      amount: String(checkout.amount),
      currency: checkout.currency,
      // What the card is actually debited. The customer agrees a USD figure and
      // is charged in shekels, so showing only the USD price would leave them
      // unable to recognize their own statement.
      charge,
      billingInterval: "MONTHLY",
      expiresAt: checkout.expiresAt,
      status,
      nextAction: nextAction(status, providerReady),
      // Retry is offered only where retrying cannot double-charge.
      retryEligible: status === "PAYMENT_REQUIRED" || status === "FAILED",
      // Both must hold: a provider that can store a card, and an approved rate
      // to charge at. Offering payment without the second sends someone to a
      // card form for a charge that would then be refused.
      paymentSetupAvailable: providerReady && charge !== null,
    },
  });
});


export default router;
