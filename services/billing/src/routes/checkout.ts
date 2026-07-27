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
import { prisma, authenticate, resolveTenant } from "@chatcenter/shared";
import type { Request, Response } from "express";
import { resolveContinuationLink, markLinkUsed } from "../services/continuation-link.service";
import { checkoutEnabled } from "../providers/capabilities";
import { getCapabilities } from "../providers";

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

function safeStatus(checkout: { status: string; expiresAt: Date }, attemptState?: string | null): SafeStatus {
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
 * Authorize a request for a checkout.
 *
 * The reference alone is never enough. A continuation token is the customer's
 * proof; a session with membership in the bound tenant is a signed-in user's.
 */
async function authorize(req: Request, checkout: { id: string; tenantId: string | null }) {
  const rawToken = typeof req.query.token === "string" ? req.query.token : null;
  if (rawToken) {
    const resolved = await resolveContinuationLink(rawToken);
    if (resolved.ok && resolved.checkout.id === checkout.id) {
      await markLinkUsed(resolved.link.id);
      return { ok: true as const, via: "continuation_link" };
    }
    return { ok: false as const };
  }

  const user = (req as any).user;
  if (!user) return { ok: false as const };
  if (user.role === "SYSTEM_ADMIN") return { ok: true as const, via: "platform_admin" };

  if (checkout.tenantId && user.userId) {
    const member = await prisma.user.findFirst({
      where: { id: user.userId, tenantId: checkout.tenantId },
      select: { id: true },
    });
    if (member) return { ok: true as const, via: "tenant_member" };
  }
  return { ok: false as const };
}

/** Uniform not-found. An unauthorized caller must not learn a reference exists. */
function notFound(res: Response) {
  return res.status(404).json({ error: "checkout_not_found" });
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

  const providerReady = checkoutEnabled(getCapabilities("ICOUNT"));
  const status = safeStatus(checkout, attempt?.state);

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
      billingInterval: "MONTHLY",
      expiresAt: checkout.expiresAt,
      status,
      nextAction: nextAction(status, providerReady),
      // Retry is offered only where retrying cannot double-charge.
      retryEligible: status === "PAYMENT_REQUIRED" || status === "FAILED",
      paymentSetupAvailable: providerReady,
    },
  });
});

/**
 * Optional authentication.
 *
 * `authenticate` rejects an anonymous request, but a customer holding a
 * continuation token legitimately has no session. So authentication is
 * attempted and its failure tolerated; `authorize` is what actually decides.
 */
function optionalAuth(req: Request, res: Response, next: () => void) {
  if (!req.headers.authorization) return next();
  authenticate(req as any, res as any, ((err?: unknown) => {
    if (err) return next();
    resolveTenant(req as any, res as any, (() => next()) as any);
  }) as any);
}

export default router;
