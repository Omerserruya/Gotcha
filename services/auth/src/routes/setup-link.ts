/**
 * Public setup-link endpoints.
 *
 * Unauthenticated by design: the person on the other end has no credential yet.
 * That is the entire point - the token in the URL is what identifies them, and
 * it is the only thing this router will accept as identification.
 *
 * `GET /api/auth/setup/:token` sends the person to the app's /recover screen
 * with our token. `POST /api/auth/setup/:token/accept` records their acceptance
 * of the Terms and the Privacy Policy and only THEN mints a fresh Authentik
 * recovery link, answered as the flow and token the screen drives. Nothing here
 * can set a password; Authentik still owns the credential. What we own is that
 * no first password can be set without a recorded acceptance: before it, no
 * token exists to set one with.
 */
import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  resolveAppPublicUrl,
  writeAudit,
  AuditAction,
  prisma,
  withCrossTenantAccess,
  createRecoveryLink,
  legalUrls,
  LEGAL_VERSIONS,
} from "@chatcenter/shared";
import {
  resolveSetupLink,
  identityForSetup,
  flowOfRecoveryUrl,
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
const acceptLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

/** The flow the setup screen names; the slug the token is minted for comes back from Authentik. */
const SETUP_FLOW = "gotcha-recovery";

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
 * GET /:token/state - the invitation as DATA.
 *
 * `GET /:token` answers with a 302 in every branch, which is right for an
 * emailed link and useless to a frontend that has to render an acceptance
 * screen: a redirect cannot say who invited whom, or why the link is dead.
 *
 * Declared BEFORE "/:token", which would otherwise match "state" as a token.
 *
 * DELIBERATELY NOT REDEEMED. Reading the state must never consume the link -
 * the screen would then break on a refresh, and a preview fetch would burn an
 * invitation before the recipient ever clicked accept. Redemption stays on the
 * redirect route, which is the one an actual click goes through.
 *
 * Deliberately thin on identity, too. An invalid token gets the same shape as
 * a valid one with nothing filled in, so this cannot be used to probe which
 * addresses are registered - the same reasoning the resend path already
 * follows.
 */
router.get("/:token/state", redeemLimiter, async (req: Request, res: Response): Promise<void> => {
  const resolution = await resolveSetupLink(String(req.params.token ?? ""));

  if (!resolution.ok) {
    res.json({
      data: {
        // invalid | expired | revoked - a code, translated by the client.
        state: resolution.reason,
        email: null,
        name: null,
        workspace: null,
        expiresAt: null,
      },
    });
    return;
  }

  const { link } = resolution;
  const [tenant, alreadyUsed] = await Promise.all([
    withCrossTenantAccess(() =>
      prisma.tenant.findUnique({ where: { id: link.tenantId }, select: { name: true } }),
    ),
    withCrossTenantAccess(() =>
      prisma.setupLink.findUnique({ where: { id: link.id }, select: { usedAt: true, expiresAt: true } }),
    ),
  ]);

  res.json({
    data: {
      // "used" is a real, separate outcome: the person already set a password
      // and the honest next screen is the ordinary way in, not an error.
      state: alreadyUsed?.usedAt ? "used" : "valid",
      email: link.email,
      name: link.name,
      workspace: tenant?.name ?? null,
      expiresAt: alreadyUsed?.expiresAt?.toISOString() ?? null,
    },
  });
});

/**
 * The emailed link: to the app's own setup screen, with our token.
 *
 * ★ NOTHING IS MINTED HERE. The Authentik token is minted by `/accept`, after
 *   the Terms are accepted. A mail scanner that opens this link spends nothing
 *   and records nothing.
 * A dead link still goes straight to the expiry page, which can offer a resend.
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

  const query = new URLSearchParams({ flow: SETUP_FLOW, setup: raw }).toString();
  res.redirect(302, `${resolveAppPublicUrl(process.env)}/recover?${query}`);
});

/** The first X-Forwarded-For hop (set by the gateway), as account.ts reads it. */
function clientIp(req: Request): string | null {
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return fwd || req.ip || null;
}

/**
 * POST /:token/accept - the Terms and the Privacy Policy accepted, then the
 * first-password flow minted.
 *
 * Body: { terms: true, privacy: true, locale: "he" | "en", capturedText }.
 * Answers:
 *   200 { status: "recovery", flow, flowToken }      the screen starts the flow
 *   200 { status: "already_has_password", next }     the ordinary way in
 *   200 { status: "expired", reason }                invalid | expired | revoked | identity_missing
 *   400 { error: "consent_required" }                either box not true; nothing written
 *   503 { error: "idp_unavailable" }                 the IdP, or the record, failed
 *
 * ★ ORDER IS THE GUARANTEE. Link checked, identity checked, then BOTH consent
 *   rows written in one transaction, then the mint. A failed write mints
 *   nothing, so there is never a token without its acceptance on file. A failed
 *   mint after a written acceptance is harmless: the person did accept, and a
 *   retry writes fresh rows (the ledger is append-only by design).
 */
router.post("/:token/accept", acceptLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.terms !== true || body.privacy !== true) {
    res.status(400).json({ error: "consent_required" });
    return;
  }
  const locale = typeof body.locale === "string" && body.locale.toLowerCase().startsWith("he") ? "he" : "en";
  const capturedText = typeof body.capturedText === "string" ? body.capturedText.trim().slice(0, 1000) : null;

  const raw = String(req.params.token ?? "");
  const resolution = await resolveSetupLink(raw);
  if (!resolution.ok) {
    res.json({ data: { status: "expired", reason: resolution.reason } });
    return;
  }
  const { link } = resolution;

  try {
    const ready = await identityForSetup(link);
    if (ready.status === "already_has_password") {
      res.json({
        data: {
          status: "already_has_password",
          next: `${resolveAppPublicUrl(process.env)}/api/auth/login?returnTo=${encodeURIComponent("/onboarding")}`,
        },
      });
      return;
    }
    if (ready.status === "no_identity") {
      res.json({ data: { status: "expired", reason: "identity_missing" } });
      return;
    }

    const urls = legalUrls(locale);
    const evidence = {
      ip: clientIp(req),
      userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null,
      capturedText,
      locale,
      channel: "setup",
      setupLinkId: link.id,
      acceptedAt: new Date().toISOString(),
    };
    const rows = [
      { purpose: "terms_of_service", document: { url: urls.terms, version: LEGAL_VERSIONS.terms } },
      { purpose: "privacy_policy", document: { url: urls.privacy, version: LEGAL_VERSIONS.privacy } },
    ];
    await withCrossTenantAccess(() =>
      prisma.$transaction(
        rows.map((r) =>
          prisma.consentRecord.create({
            data: {
              tenantId: link.tenantId,
              subjectType: "user",
              subjectId: link.userId,
              purpose: r.purpose,
              granted: true,
              source: "setup",
              evidence: { ...evidence, document: r.document },
            },
          }),
        ),
      ),
    );
    void writeAudit({
      tenantId: link.tenantId,
      actorType: "user",
      actorId: link.userId,
      action: AuditAction.CONSENT_GRANTED,
      targetType: "user",
      targetId: link.userId,
      metadata: { purposes: rows.map((r) => r.purpose), versions: LEGAL_VERSIONS, source: "setup", locale },
    });

    const flow = flowOfRecoveryUrl(await createRecoveryLink(ready.pk));
    if (!flow) throw new Error("recovery link in an unrecognised shape");

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
    res.json({ data: { status: "recovery", flow: flow.flow, flowToken: flow.flowToken } });
  } catch (err: any) {
    // The IdP (or the database) being unreachable is not the recipient's fault
    // and must not read like a dead link, because theirs still works.
    console.error("[setup-link] accept failed:", err?.message ?? err);
    res.status(503).json({ error: "idp_unavailable" });
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
