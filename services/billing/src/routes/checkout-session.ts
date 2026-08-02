/**
 * The two things a customer's browser may ask us to DO.
 *
 * Deliberately separate from checkout.ts, which is read-only and must stay
 * provably so. Both endpoints here mutate, and both are careful about the same
 * thing: the request is a prompt to re-check, never a report of what happened.
 *
 * Neither accepts a status, a token, a transaction id or a success flag from
 * the client. `advance` takes no body at all beyond authorization. Whatever a
 * browser sends, the answer comes from asking the provider and reading our own
 * attempt rows.
 */
import { Router } from "express";
import { prisma } from "@chatcenter/shared";
import {
  authorizeCheckout,
  checkoutNotFound,
  optionalAuth,
} from "../lib/checkout-auth";
import {
  advanceCheckout,
  startPaymentSetup,
  CheckoutProgressRefused,
} from "../services/checkout-progress.service";
import { declineCategory } from "../lib/decline-category";
import { buildReturnUrl } from "../lib/public-url";
import { notifyPaymentSucceeded } from "../lib/auth-notify";

const router = Router();

/**
 * Per-reference limiter.
 *
 * Tighter than the status poll: starting a payment session talks to the
 * provider, and advancing may charge a card.
 */
const HITS = new Map<string, { count: number; resetAt: number }>();
const LIMIT = 20;
const WINDOW_MS = 60_000;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hit = HITS.get(key);
  if (!hit || hit.resetAt < now) {
    HITS.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  hit.count += 1;
  return hit.count > LIMIT;
}

async function loadAndAuthorize(req: any, res: any) {
  const reference = String(req.params.reference || "");
  if (!reference.startsWith("chk_")) {
    checkoutNotFound(res);
    return null;
  }
  if (rateLimited(reference)) {
    res.status(429).json({ error: "rate_limited" });
    return null;
  }
  const checkout = await prisma.pendingCheckout.findUnique({ where: { reference } });
  if (!checkout) {
    checkoutNotFound(res);
    return null;
  }
  const auth = await authorizeCheckout(req, checkout, res);
  // Same response as a missing checkout, so an unauthorized caller cannot probe
  // which references exist.
  if (!auth.ok) {
    checkoutNotFound(res);
    return null;
  }
  return checkout;
}

/**
 * Start (or resume) payment setup.
 *
 * Returns where to send the customer. The URL is generated server-side from a
 * configured page id - a client-supplied destination would be an open redirect
 * into a page that asks for card details.
 */
router.post("/checkout/:reference/payment-session", optionalAuth, async (req, res) => {
  const checkout = await loadAndAuthorize(req, res);
  if (!checkout) return;

  try {
    const result = await startPaymentSetup(checkout.reference, {
      successUrl: returnUrl("processing", checkout.reference),
      failureUrl: returnUrl("failed", checkout.reference),
      // Abandoning the hosted page is not a failure: nothing was attempted, so
      // the checkout stays exactly as it was and the customer can start again.
      cancelUrl: returnUrl("cancelled", checkout.reference),
    });
    // The session id is not returned. The customer does not need it, and it
    // would only be one more identifier travelling through a browser.
    res.json({ data: { redirectUrl: result.redirectUrl } });
  } catch (err) {
    respondRefusal(res, err);
  }
});

/**
 * Ask the server to re-check and move the checkout forward.
 *
 * This is what the waiting page polls. Safe to call repeatedly: every step it
 * drives is individually idempotent, so a customer refreshing during a charge
 * cannot cause a second one.
 */
router.post("/checkout/:reference/advance", optionalAuth, async (req, res) => {
  const checkout = await loadAndAuthorize(req, res);
  if (!checkout) return;

  try {
    const result = await advanceCheckout(checkout.reference);
    res.json({ data: safeAdvance(result) });
  } catch (err) {
    respondRefusal(res, err);
  }
});

/**
 * Send the post-payment welcome email again.
 *
 * A paid signup can complete the entire purchase without ever authenticating,
 * so that email is the only thing carrying the admin a way to set a password.
 * If it does not arrive they are locked out of what they just bought, and the
 * ordinary repair (POST /agents/:id/reset-password) requires the very
 * permissions they cannot yet hold. This is their own way to ask again.
 *
 * It discloses nothing: the address is never echoed and the link never
 * returned, so a caller who reached this without standing learns only that
 * something was posted. Delivery to the address on file stays the sole proof
 * of who the recipient is.
 */
router.post("/checkout/:reference/resend-welcome", optionalAuth, async (req, res) => {
  const checkout = await loadAndAuthorize(req, res);
  if (!checkout) return;

  // Only once the money is in. Before that there is nothing to welcome anyone
  // to, and this email hands out a credential link.
  if (checkout.status !== "PAID" || !checkout.tenantId) return checkoutNotFound(res);

  const [tenant, plan] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: checkout.tenantId }, select: { name: true } }),
    prisma.plan.findFirst({ where: { key: checkout.planKey }, select: { name: true } }),
  ]);

  await notifyPaymentSucceeded({
    tenantId: checkout.tenantId,
    tenantName: tenant?.name ?? "your organization",
    planName: plan?.name ?? checkout.planKey,
    includedCredits: checkout.snapshotIncludedCredits,
    resend: true,
  });

  res.json({ data: { sent: true } });
});

/**
 * Strip anything a customer should not see.
 *
 * A raw provider decline string can carry account details and reads like an
 * error log. The customer gets a category; the detail stays on the attempt row
 * for support.
 */
function safeAdvance(result: Awaited<ReturnType<typeof advanceCheckout>>) {
  switch (result.phase) {
    case "PAID":
      return { phase: "PAID" };
    case "PAYMENT_FAILED":
      return { phase: "PAYMENT_FAILED", declineCategory: declineCategory(result.failureCode) };
    case "NEEDS_ATTENTION":
      // Deliberately not the internal state name.
      return { phase: "NEEDS_ATTENTION" };
    default:
      return { phase: result.phase };
  }
}

/**
 * Where the customer comes back to.
 *
 * Built from configuration and a fixed path, never from anything a request
 * supplied. A misconfiguration returns undefined rather than throwing here, so
 * a checkout does not fail outright on it - but startup already refuses to boot
 * a payment-enabled stack without a valid value, so reaching this in production
 * means the environment changed under a running process.
 */
function returnUrl(page: string, reference: string): string | undefined {
  try {
    return buildReturnUrl(`/checkout/${encodeURIComponent(page)}`, { ref: reference });
  } catch (err) {
    console.error("[billing] cannot build a return URL:", (err as Error).message);
    return undefined;
  }
}

function respondRefusal(res: any, err: unknown) {
  if (err instanceof CheckoutProgressRefused) {
    const status = err.code === "checkout_not_found" ? 404 : 409;
    return res.status(status).json({ error: err.code });
  }
  // Never echo a provider or database error to a customer: they carry internal
  // detail and read as though they did something wrong.
  console.error("[billing] checkout session error:", err);
  return res.status(500).json({ error: "checkout_unavailable" });
}

export default router;
