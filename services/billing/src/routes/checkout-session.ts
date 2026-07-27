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
  const auth = await authorizeCheckout(req, checkout);
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
      return { phase: "PAYMENT_FAILED", declineCategory: categorize(result.failureCode) };
    case "NEEDS_ATTENTION":
      // Deliberately not the internal state name.
      return { phase: "NEEDS_ATTENTION" };
    default:
      return { phase: result.phase };
  }
}

/** A coarse, customer-safe reason. Enough to know whether to try another card. */
function categorize(failureCode?: string): string {
  const code = (failureCode ?? "").toLowerCase();
  if (/expired/.test(code)) return "CARD_EXPIRED";
  if (/insufficient|funds|limit/.test(code)) return "INSUFFICIENT_FUNDS";
  if (/declin|refus|denied/.test(code)) return "DECLINED";
  if (/invalid|token/.test(code)) return "CARD_UNUSABLE";
  return "DECLINED";
}

function returnUrl(page: string, reference: string): string | undefined {
  const base = (process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!base) return undefined;
  return `${base}/checkout/${page}?ref=${encodeURIComponent(reference)}`;
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
