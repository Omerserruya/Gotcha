/**
 * Public setup-link endpoints.
 *
 * Unauthenticated by design: the person on the other end has no credential yet.
 * That is the entire point - the token in the URL is what identifies them, and
 * it is the only thing this router will accept as identification.
 *
 * `GET /api/auth/setup/:token` mints a FRESH Authentik recovery link and
 * redirects into it. Nothing here can set a password; Authentik still owns the
 * credential, exactly as it did when we mailed its link directly. What changed
 * is WHEN the IdP's 30-minute window opens: at the click instead of at the send.
 */
import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { resolveAppPublicUrl, writeAudit, AuditAction } from "@chatcenter/shared";
import {
  resolveSetupLink,
  redeemForRecoveryUrl,
  markSetupLinkUsed,
  ownerOfSetupToken,
} from "../services/setup-link.service";
import { sendSetupLinkEmail } from "../services/notification.service";

const router = Router();

/**
 * Generous on GET, tight on resend.
 *
 * A person fumbling with an invitation may well hit the redeem URL several
 * times (back button, a second device, a mail client that prefetches), and
 * rate-limiting them into a wall is how a recoverable annoyance becomes a
 * support ticket. Sending mail is the expensive, abusable side, so that is
 * where the low ceiling goes.
 */
const redeemLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const resendLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });

/** Where a link that cannot be redeemed sends the person. */
function expiredPage(reason: string, token?: string): string {
  const base = `${resolveAppPublicUrl(process.env)}/setup-link/expired?reason=${encodeURIComponent(reason)}`;
  // The dead token rides along so the page can offer "send me a new one"
  // without asking an anonymous visitor to type an email address, which would
  // turn this page into an account-existence oracle. Only tokens that have
  // ALREADY been refused ever reach here.
  return token ? `${base}&t=${encodeURIComponent(token)}` : base;
}

/**
 * Redeem a setup link.
 *
 * Always a redirect, never a JSON body: this URL is opened by a human in a
 * browser straight from an email, and the only useful response is the next
 * screen.
 */
router.get("/:token", redeemLimiter, async (req: Request, res: Response): Promise<void> => {
  const raw = String(req.params.token ?? "");
  const resolution = await resolveSetupLink(raw);

  if (!resolution.ok) {
    // Recorded without a tenant: an invalid token has no tenant to attribute
    // it to, and inventing one would be worse than a null.
    void writeAudit({
      tenantId: null as any,
      actorType: "system",
      actorId: null,
      action: AuditAction.SETUP_LINK_REJECTED,
      targetType: "setup_link",
      targetId: null,
      metadata: { reason: resolution.reason },
    });
    res.redirect(302, expiredPage(resolution.reason, resolution.reason === "invalid" ? undefined : raw));
    return;
  }

  const { link } = resolution;
  try {
    const outcome = await redeemForRecoveryUrl(link);

    if (outcome.status === "already_has_password") {
      // Not an error, and deliberately not the expiry page. This person has a
      // credential already; the honest next screen is the ordinary way in.
      res.redirect(302, `${resolveAppPublicUrl(process.env)}/login?next=/setup`);
      return;
    }
    if (outcome.status === "no_identity") {
      res.redirect(302, expiredPage("identity_missing", raw));
      return;
    }

    await markSetupLinkUsed(link.id);
    void writeAudit({
      tenantId: link.tenantId,
      actorType: "system",
      actorId: null,
      action: AuditAction.SETUP_LINK_REDEEMED,
      targetType: "user",
      targetId: link.userId,
      metadata: {},
    });
    res.redirect(302, outcome.url);
  } catch (err: any) {
    // The IdP being unreachable is not the recipient's fault and must not read
    // like a dead link, because theirs still works.
    console.error("[setup-link] redeem failed:", err?.message ?? err);
    res.redirect(302, expiredPage("idp_unavailable", raw));
  }
});

/**
 * Ask for a replacement link.
 *
 * Always the same 200, whatever happened - including when the token is unknown
 * or the mail fails. The token is the identifier, so a wrong one must be
 * indistinguishable from a valid one, or this endpoint becomes a way to test
 * whether a token (and therefore an account) exists.
 */
router.post("/resend", resendLimiter, async (req: Request, res: Response): Promise<void> => {
  const raw = (req.body ?? {}).token;
  try {
    const owner = await ownerOfSetupToken(raw);
    if (owner) {
      await sendSetupLinkEmail(owner.userId);
      void writeAudit({
        tenantId: owner.tenantId,
        actorType: "system",
        actorId: null,
        action: AuditAction.SETUP_LINK_ISSUED,
        targetType: "user",
        targetId: owner.userId,
        metadata: { via: "self_service_resend" },
      });
    }
  } catch (err: any) {
    console.error("[setup-link] resend failed:", err?.message ?? err);
  }
  res.json({ ok: true });
});

export default router;
