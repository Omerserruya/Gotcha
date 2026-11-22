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
import { requireInternalKey, prisma, resolveAppPublicUrl } from "@chatcenter/shared";
import { tenantAdminEntry } from "../services/invitation.service";
import { sendPaymentSucceededEmail, sendShopifyCustomAppEmail } from "../services/notification.service";

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

/**
 * The emails of a per-merchant Shopify custom app (2026-11-22; ai routes/shopify-custom-app.ts asks):
 *   - request_notice: to SHOPIFY_CUSTOM_APP_NOTIFY_EMAIL (unset: nothing sent, the console list remains);
 *   - install_link: to EVERY active admin of the workspace (Omer, 2026-11-22), and to the person who asked
 *     when they are not one, one email each (no address sees another).
 * 200 with sent:false when there is nobody to send to; 500 when the mail itself failed.
 */
router.post("/internal/auth/shopify-custom-app-email", async (req, res) => {
  const { kind, tenantId, userId, shopDomain, installLink, expiresAt, requestedAt } = req.body ?? {};
  if ((kind !== "request_notice" && kind !== "install_link") || !tenantId || !shopDomain) {
    return res.status(400).json({ error: "kind, tenantId and shopDomain required" });
  }
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: String(tenantId) }, select: { name: true, defaultLocale: true } });
    if (!tenant) return res.status(404).json({ error: "tenant_not_found" });
    let recipients: string[] = [];
    if (kind === "request_notice") {
      const notify = (process.env.SHOPIFY_CUSTOM_APP_NOTIFY_EMAIL || "").trim();
      recipients = notify ? [notify] : [];
    } else {
      const admins = await prisma.user.findMany({
        where: { tenantId: String(tenantId), role: "ADMIN", isActive: true },
        select: { email: true },
        orderBy: { createdAt: "asc" },
      });
      const asker = userId
        ? await prisma.user.findFirst({ where: { id: String(userId), tenantId: String(tenantId), isActive: true }, select: { email: true } })
        : null;
      const seen = new Set<string>();
      for (const e of [...admins.map((a: any) => a.email), asker?.email]) {
        const k = String(e ?? "").trim().toLowerCase();
        if (k && !seen.has(k)) { seen.add(k); recipients.push(String(e).trim()); }
      }
    }
    if (!recipients.length) return res.json({ ok: true, sent: false, reason: "no_recipient" });
    let consoleUrl = "";
    try { consoleUrl = `${resolveAppPublicUrl()}/system/shopify-custom-apps`; } catch { consoleUrl = ""; }
    let sent = 0;
    for (const to of recipients) {
      await sendShopifyCustomAppEmail({
        kind, tenantId: String(tenantId), tenantName: tenant.name, shopDomain: String(shopDomain), to,
        locale: String(tenant.defaultLocale ?? "").toLowerCase().startsWith("he") ? "he" : "en",
        installLink: typeof installLink === "string" ? installLink : undefined,
        expiresAt: typeof expiresAt === "string" ? expiresAt : undefined,
        requestedAt: typeof requestedAt === "string" ? requestedAt : undefined,
        consoleUrl,
      });
      sent++;
    }
    return res.json({ ok: true, sent: true, recipients: sent });
  } catch (err: any) {
    console.error("[internal] shopify custom-app email failed:", err?.message);
    return res.status(500).json({ error: "email_failed" });
  }
});

export default router;

