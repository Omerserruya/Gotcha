/**
 * Service-to-service routes for auth.
 *
 * Authenticated with the shared X-Internal-Key, never a user token: the caller
 * is another GOTCHA service, not a person. The gateway does no auth of its own,
 * so the guard sits here and fails closed.
 *
 * Identity is auth's domain, so anything that has to mint a credential link or
 * decide who a tenant's admin is belongs on this side of the wire. Billing asks;
 * it does not reach into Authentik itself.
 */
import { Router } from "express";
import { requireInternalKey } from "@chatcenter/shared";
import { tenantAdminEntry } from "../services/invitation.service";
import { sendPaymentSucceededEmail } from "../services/notification.service";

const router = Router();

router.use("/internal/auth", requireInternalKey);

/**
 * A tenant's payment cleared: welcome them and hand over the way in.
 *
 * Called by billing at activation. The commercial facts travel in the request
 * because they are billing's to state; auth supplies only the identity half.
 *
 * Answers 200 even when there is nothing to send. The money is already
 * settled, and a failure here must read as "no email went out", never as a
 * reason for the caller to retry a payment.
 */
router.post("/internal/auth/payment-succeeded", async (req, res) => {
  const { tenantId, tenantName, planName, includedCredits, locale, resend } = req.body ?? {};
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  try {
    const entry = await tenantAdminEntry(String(tenantId));
    if (!entry) return res.json({ ok: true, sent: false, reason: "no_admin_to_notify" });

    await sendPaymentSucceededEmail({
      tenantId: String(tenantId),
      adminEmail: entry.user.email,
      adminName: entry.user.name,
      tenantName: String(tenantName ?? "your organization"),
      planName: String(planName ?? "your plan"),
      includedCredits: Number(includedCredits ?? 0),
      actionUrl: entry.actionUrl,
      needsPassword: entry.needsPassword,
      locale: locale ? String(locale) : undefined,
      resend: resend === true,
    });

    // The link itself is never returned. It is a credential, and the only
    // thing that establishes the recipient is delivery to the address on file.
    return res.json({ ok: true, sent: true, needsPassword: entry.needsPassword });
  } catch (err: any) {
    console.error("[internal] payment-succeeded notification failed:", err?.message ?? err);
    return res.status(200).json({ ok: false, sent: false, error: "notification_failed" });
  }
});

export default router;
