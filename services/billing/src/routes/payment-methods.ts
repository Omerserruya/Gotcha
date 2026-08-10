/**
 * Payment methods.
 *
 * The card is entered on the provider's hosted page; GOTCHA stores only the
 * resulting token and card metadata, encrypted. Raw PAN never touches us.
 *
 * The client used to POST a page token it had received in the browser, and we
 * stored whatever it sent. That is the wrong shape for the same reason a
 * redirect is not a receipt: the browser is reporting an outcome it is not in a
 * position to know. Adding a card is now the same two-step as checkout - start
 * a session, then ask the SERVER to confirm a new card exists.
 *
 * Storing a card is NOT a purchase and provisions nothing on its own.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission, prisma } from "@chatcenter/shared";
import { ensureBillableEntity } from "../services/billable-entity.service";
import {
  startTokenizationSession,
  verifyTokenizationSession,
  TokenizationRefused,
} from "../services/tokenization.service";
import { checkoutEnabled } from "../providers/capabilities";
import { getCapabilities } from "../providers";
import { buildReturnUrl } from "../lib/public-url";

const router = Router();

/**
 * Where the provider sends the person once the card is stored.
 *
 * Without it the hosted page has nowhere to go, so it shows its own "thank
 * you" and the browser never returns. The card really is stored at the
 * provider, but the confirm step - the server-side pull that turns a stored
 * card into a PaymentMethod row - is only triggered when the page reloads. The
 * result was a customer who had entered their card being told none was saved,
 * and a tokenization session left AWAITING_RETURN until it expired.
 *
 * The path is the add-card page itself: it keeps the session id in
 * sessionStorage and confirms on mount, so simply arriving back is enough. No
 * identifier travels in the URL.
 *
 * Returns undefined rather than throwing when the public origin is not
 * configured. A missing return URL degrades the experience; refusing to start
 * the session at all would remove the only way to add a card.
 */
function cardReturnUrl(): string | undefined {
  try {
    return buildReturnUrl("/settings/billing/payment-method");
  } catch (err) {
    console.error("[billing] cannot build a card return URL:", (err as Error).message);
    return undefined;
  }
}

router.get("/billing/payment-methods", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: req.tenantId! } });
  if (!link) return res.json({ paymentMethods: [] });
  const profile = await prisma.billingProfile.findUnique({ where: { billableEntityId: link.billableEntityId }, include: { paymentMethods: { where: { status: "ACTIVE" } } } });
  res.json({ paymentMethods: profile?.paymentMethods ?? [] });
});

/**
 * Start adding (or replacing) a card.
 *
 * Returns where to send the person. Their browser then comes back and calls
 * confirm, which asks the provider what actually happened.
 */
router.post(
  "/billing/payment-methods/session",
  authenticate,
  resolveTenant,
  requirePermission("settings:billing:manage"),
  async (req, res) => {
    if (!checkoutEnabled(getCapabilities("ICOUNT"))) {
      return res.status(409).json({ error: "payment_setup_unavailable" });
    }
    try {
      await ensureBillableEntity(req.tenantId!);
      const { session, saleUrl } = await startTokenizationSession({
        tenantId: req.tenantId!,
        customerEmail: req.user?.email,
        successUrl: cardReturnUrl(),
      });
      return res.json({ data: { redirectUrl: saleUrl, sessionId: session.id } });
    } catch (err: any) {
      if (err instanceof TokenizationRefused) return res.status(409).json({ error: err.code });
      console.error("[billing] payment method session failed:", err);
      return res.status(500).json({ error: "payment_setup_failed" });
    }
  },
);

/**
 * Confirm that a card was stored.
 *
 * Takes only the session id - no token, no card details, no success flag. The
 * answer comes from querying the provider and comparing against the baseline
 * captured when the session started, so a person who abandoned the page cannot
 * end up with a card they never entered attributed to this attempt.
 */
router.post(
  "/billing/payment-methods/confirm",
  authenticate,
  resolveTenant,
  requirePermission("settings:billing:manage"),
  async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "");
    if (!sessionId) return res.status(400).json({ error: "session_required" });

    const session = await prisma.tokenizationSession.findUnique({ where: { id: sessionId } });
    // Scoped to the caller's tenant: a session id is otherwise a way to claim
    // someone else's stored card.
    if (!session || session.tenantId !== req.tenantId) {
      return res.status(404).json({ error: "session_not_found" });
    }

    try {
      const result = await verifyTokenizationSession(sessionId);
      if (!result.verified) {
        return res.json({ data: { status: "PENDING", reason: result.reason } });
      }

      const method = await prisma.paymentMethod.findUnique({ where: { id: result.paymentMethodId } });

      // Replace semantics: a tenant has at most ONE active card. Retire every
      // prior one so no orphaned token lingers and the default is unambiguous.
      await prisma.paymentMethod.updateMany({
        where: {
          billingProfileId: method!.billingProfileId,
          id: { not: method!.id },
          status: "ACTIVE",
        },
        data: { status: "REMOVED", isDefault: false },
      });

      // Storing a card provisions NOTHING. It used to auto-start a trial on a
      // default plan key, handing the customer a subscription they never chose.
      return res.json({
        data: {
          status: "STORED",
          paymentMethod: {
            id: method!.id,
            brand: method!.brand,
            last4: method!.last4,
            expMonth: method!.expMonth,
            expYear: method!.expYear,
          },
        },
      });
    } catch (err: any) {
      if (err instanceof TokenizationRefused) return res.status(409).json({ error: err.code });
      console.error("[billing] payment method confirm failed:", err);
      return res.status(500).json({ error: "payment_setup_failed" });
    }
  },
);

router.delete("/billing/payment-methods/:id", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  // Ownership scoping (cross-tenant IDOR guard). PaymentMethod has no tenantId
  // column - it hangs off BillingProfile -> BillableEntity -> tenant - so the
  // Prisma tenant-guard does NOT cover it. Resolve THIS tenant's billing profile
  // and scope the write with updateMany so a payment-method id belonging to
  // another tenant matches zero rows instead of being mutated by raw id.
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: req.tenantId! } });
  if (!link) return res.json({ ok: true });
  const profile = await prisma.billingProfile.findUnique({ where: { billableEntityId: link.billableEntityId }, select: { id: true } });
  if (!profile) return res.json({ ok: true });
  await prisma.paymentMethod.updateMany({
    where: { id: String(req.params.id), billingProfileId: profile.id },
    data: { status: "REMOVED", isDefault: false },
  });
  res.json({ ok: true });
});

export default router;
