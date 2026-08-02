/**
 * Self-service Account API.
 *
 * Everything a signed-in user may do to THEIR OWN account, without an admin and
 * without leaving GOTCHA. Profile fields (name/phone/locale) live in GOTCHA;
 * credential/MFA/session data lives in Authentik and is surfaced here through
 * the admin API scoped to the caller's own identity - so the Account page reads
 * as one product instead of redirecting to the IdP.
 *
 * Auth: `authenticate` only (no role gate) - every field/action is the caller's
 * own, resolved from req.user, never from a client-supplied id.
 */

import crypto from "crypto";
import { Router, Request, Response } from "express";
import {
  authenticate,
  prisma,
  withCrossTenantAccess,
  writeAudit,
  AuditAction,
  findIdentityBySubject,
  createRecoveryLink,
  updateIdentity,
  listUserSessions,
  terminateSession,
  terminateAllUserSessions,
  listUserLoginEvents,
  listUserDevices,
  deleteUserDevice,
  mfaRequirementFor,
  isEnrolledWithRecovery,
  isSupportedLocale,
  getOAuthStateSecret,
  type RemovableDeviceType,
  resolveAppPublicUrl,
} from "@chatcenter/shared";
import { sendEmailChangeVerification } from "../services/notification.service";

const router = Router();
router.use(authenticate);

/** Resolve the caller's Authentik pk (or null) from their identity's subject. */
async function callerIdentity(req: Request): Promise<{ pk: number; username: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { identity: { select: { authentikSubject: true } } },
  });
  const subject = user?.identity?.authentikSubject;
  if (!subject) return null;
  const identity = await findIdentityBySubject(subject);
  return identity ? { pk: identity.pk, username: identity.username } : null;
}

// ─── Profile ───────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: {
      id: true, name: true, email: true, phoneNumber: true, locale: true,
      role: true, tenantId: true, createdAt: true,
    },
  });
  if (!user) { res.status(404).json({ error: "not_found" }); return; }
  const member = await prisma.departmentMember.findFirst({
    // tenantId REQUIRED (tenant-guarded model + bulk op) - findUnique was exempt.
    where: { userId: user.id, tenantId: user.tenantId },
    orderBy: { createdAt: "asc" },
    include: { department: { select: { name: true } } },
  });
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId }, select: { name: true, defaultLocale: true },
  });
  res.json({
    user,
    departmentName: member?.department?.name ?? null,
    tenantName: tenant?.name ?? null,
    tenantDefaultLocale: tenant?.defaultLocale ?? "en",
  });
});

/** Update own profile: name, phone, locale. (Email is a verified flow - separate.) */
router.patch("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 120);
    if (body.phoneNumber === null || typeof body.phoneNumber === "string") {
      data.phoneNumber = body.phoneNumber ? String(body.phoneNumber).trim().slice(0, 32) : null;
    }
    if (typeof body.locale === "string" && isSupportedLocale(body.locale)) data.locale = body.locale;
    if (Object.keys(data).length === 0) { res.status(400).json({ error: "no_editable_fields" }); return; }

    const before = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { name: true, identityId: true, identity: { select: { authentikSubject: true } } },
    });
    const updated = await prisma.user.update({
      where: { id: req.user!.userId },
      data,
      select: { id: true, name: true, email: true, phoneNumber: true, locale: true, role: true },
    });

    // A rename is identity-level: update the Identity master, every other
    // membership's display mirror, and the IdP - so the person is one name
    // everywhere, not a different one per workspace.
    if (typeof data.name === "string" && before && data.name !== before.name) {
      try {
        await prisma.identity.update({ where: { id: before.identityId }, data: { name: updated.name } });
        // Cross-tenant on purpose: every membership mirror of THIS person.
        await withCrossTenantAccess(() =>
          prisma.user.updateMany({ where: { identityId: before.identityId }, data: { name: updated.name } }),
        );
        if (before.identity?.authentikSubject) {
          const identity = await findIdentityBySubject(before.identity.authentikSubject);
          if (identity) await updateIdentity(identity.pk, { name: updated.name });
        }
      } catch (e: any) { console.warn("[account] name sync failed:", e?.message); }
    }

    void writeAudit({
      tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId,
      action: AuditAction.USER_UPDATED, targetType: "user", targetId: updated.id,
      metadata: { self: true, fields: Object.keys(data) },
    });
    res.json({ user: updated });
  } catch (err: any) {
    console.error("[account] profile update error:", err?.message);
    res.status(500).json({ error: "update_failed" });
  }
});

// ─── Security summary (MFA / passkeys / recovery / last login) ───────────────

router.get("/security", async (req: Request, res: Response): Promise<void> => {
  const identity = await callerIdentity(req);
  if (!identity) { res.json({ available: false, reason: "no_identity" }); return; }
  try {
    const summary = await listUserDevices(identity.pk);
    res.json({ available: true, ...summary });
  } catch (err: any) {
    // Degrade gracefully - the page still renders with deep-link fallbacks.
    res.json({ available: false, reason: "idp_unavailable", error: err?.message });
  }
});

/** One-time link into Authentik's password-change flow, for the caller. */
router.post("/password-link", async (req: Request, res: Response): Promise<void> => {
  const identity = await callerIdentity(req);
  if (!identity) { res.status(409).json({ error: "no_identity" }); return; }
  try {
    const link = await createRecoveryLink(identity.pk);
    void writeAudit({
      tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId,
      action: AuditAction.PASSWORD_RESET_REQUESTED, targetType: "user", targetId: req.user!.userId,
      metadata: { self: true },
    });
    res.json({ link });
  } catch (err: any) {
    res.status(502).json({ error: "idp_unavailable" });
  }
});

// ─── MFA enforcement gate ────────────────────────────────────────────────────

/**
 * Is this caller required to have MFA, and have they enrolled?
 *
 * The single source of truth the frontend enrolment gate polls. Enforcement is
 * hierarchical (SYSTEM_ADMIN always; ADMIN/AGENT per the tenant's policy) and
 * "enrolled" means an authenticator AND recovery codes. We stamp
 * `User.mfaEnrolledAt` from the live Authentik state so the cheap local guard
 * and the Workspace compliance counts stay in sync without their own IdP calls.
 */
router.get("/mfa-gate", async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: {
      role: true, identityId: true,
      identity: { select: { authentikSubject: true, mfaEnrolledAt: true } },
      tenant: { select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true } },
    },
  });
  if (!user) { res.status(404).json({ error: "not_found" }); return; }
  const mfaStamp = user.identity.mfaEnrolledAt;

  const requirement = mfaRequirementFor(user.role, {
    mfaRequiredForAdmins: user.tenant.mfaRequiredForAdmins,
    mfaRequiredForAllUsers: user.tenant.mfaRequiredForAllUsers,
  });

  // Resolve live enrolment from Authentik. If the IdP is unreachable, fall back
  // to the stored stamp so a transient blip never forces an enrolled user back
  // through setup (fail-safe for availability, still closed for never-enrolled).
  //
  // NOTE: callerIdentity() itself calls Authentik and THROWS on an IdP error
  // (findIdentityBySubject has no catch). It must live inside the same try so an
  // outage routes into the stamp fallback below - otherwise the handler 500s
  // before it can fall back, the client treats the error as "no gate", and a
  // required-but-unenrolled user sails straight in. That is the exact fail-open
  // this fallback exists to prevent.
  let enrolled: boolean;
  let hasAuthenticator = false;
  let hasRecovery = false;
  let live = false;
  let identityAvailable = false;
  try {
    const identity = await callerIdentity(req);
    identityAvailable = !!identity;
    if (identity) {
      const summary = await listUserDevices(identity.pk);
      hasAuthenticator = summary.totp.length > 0 || summary.passkeys.length > 0;
      hasRecovery = summary.recoveryCodes.length > 0;
      enrolled = isEnrolledWithRecovery(summary);
      live = true;
    } else {
      // Identity genuinely not found (empty result, not an error) - fall back
      // to the stamp; a never-enrolled user stays gated (stamp is null).
      enrolled = mfaStamp != null;
    }
  } catch {
    // IdP error: fail CLOSED for enforcement - trust only the stored stamp.
    enrolled = mfaStamp != null;
  }

  // Keep the local mirror honest whenever we have a live read. The stamp is
  // identity-level: enrolling once satisfies every tenant membership.
  if (live) {
    if (enrolled && !mfaStamp) {
      await prisma.identity.update({ where: { id: user.identityId }, data: { mfaEnrolledAt: new Date() } });
    } else if (!enrolled && mfaStamp) {
      await prisma.identity.update({ where: { id: user.identityId }, data: { mfaEnrolledAt: null } });
    }
  }

  res.json({
    required: requirement.required,
    reason: requirement.reason,
    enrolled,
    hasAuthenticator,
    hasRecovery,
    mustEnroll: requirement.required && !enrolled,
    identityAvailable,
  });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

/** Remove one of the caller's own authenticator devices (TOTP / passkey / recovery set). */
router.delete("/security/device/:type/:id", async (req: Request, res: Response): Promise<void> => {
  const type = req.params.type as RemovableDeviceType;
  if (!["totp", "webauthn", "static"].includes(type)) { res.status(400).json({ error: "bad_type" }); return; }
  const deviceId = String(req.params.id);
  const identity = await callerIdentity(req);
  if (!identity) { res.status(409).json({ error: "no_identity" }); return; }
  // Verify the device belongs to the caller AND is of the requested type.
  // Authentik device pks are per-type (each type is its own model with its own
  // pk sequence), so `totp#5`, `static#5` and `webauthn#5` are three different
  // objects owned by potentially three different users. Matching on id across
  // the union while deleting `${type}/${id}` would let a caller who owns
  // e.g. totp#5 delete another user's static#5 (recovery codes) - an IDOR.
  // Check only the bucket that corresponds to the delete target's type.
  const summary = await listUserDevices(identity.pk);
  const bucket = type === "totp" ? summary.totp
    : type === "webauthn" ? summary.passkeys
    : summary.recoveryCodes;
  if (!bucket.some((d) => d.id === deviceId)) { res.status(404).json({ error: "device_not_found" }); return; }
  try {
    await deleteUserDevice(type, deviceId);
    // Removing a factor can drop the user below "enrolled" - clear the mirror so
    // the gate re-evaluates on next check (and re-challenges if policy requires).
    const me = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { identityId: true } });
    if (me) await prisma.identity.update({ where: { id: me.identityId }, data: { mfaEnrolledAt: null } });
    void writeAudit({
      tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId,
      action: AuditAction.MFA_DEVICE_REMOVED, targetType: "user", targetId: req.user!.userId,
      metadata: { self: true, deviceType: type },
    });
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "idp_unavailable" });
  }
});

router.get("/sessions", async (req: Request, res: Response): Promise<void> => {
  const identity = await callerIdentity(req);
  if (!identity) { res.json({ available: false, sessions: [] }); return; }
  try {
    // Identify the caller's own session so the UI can badge "This device":
    // the client IP (first X-Forwarded-For hop, set by the gateway) + the
    // browser UA uniquely match the row Authentik recorded for this session.
    const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    const ip = fwd || req.ip || null;
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
    const sessions = await listUserSessions(identity.pk, { ip, userAgent });
    res.json({ available: true, sessions });
  } catch {
    res.json({ available: false, sessions: [] });
  }
});

router.delete("/sessions/:id", async (req: Request, res: Response): Promise<void> => {
  const identity = await callerIdentity(req);
  if (!identity) { res.status(409).json({ error: "no_identity" }); return; }
  // Only allow terminating a session that actually belongs to the caller.
  const own = await listUserSessions(identity.pk);
  const target = own.find((s) => s.id === req.params.id);
  if (!target) { res.status(404).json({ error: "session_not_found" }); return; }
  try {
    await terminateSession(target.id);
    void writeAudit({
      tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId,
      action: AuditAction.SESSION_TERMINATED, targetType: "session", targetId: target.id, metadata: { self: true },
    });
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "idp_unavailable" });
  }
});

router.delete("/sessions", async (req: Request, res: Response): Promise<void> => {
  const identity = await callerIdentity(req);
  if (!identity) { res.status(409).json({ error: "no_identity" }); return; }
  try {
    // "Sign out everywhere ELSE": identify the caller's own session (same
    // IP+UA heuristic the list uses) and keep it, unless the caller explicitly
    // asks to include it (?includeCurrent=1 - a true global sign-out).
    let keep: string | undefined;
    if (req.query.includeCurrent !== "1") {
      const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
      const sessions = await listUserSessions(identity.pk, {
        ip: fwd || req.ip || null,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      });
      keep = sessions.find((s) => s.current)?.id;
    }
    const n = await terminateAllUserSessions(identity.pk, keep);
    void writeAudit({
      tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId,
      action: AuditAction.ALL_SESSIONS_TERMINATED, targetType: "user", targetId: req.user!.userId,
      metadata: { self: true, count: n },
    });
    res.json({ ok: true, terminated: n });
  } catch {
    res.status(502).json({ error: "idp_unavailable" });
  }
});

// ─── Login history ───────────────────────────────────────────────────────────

router.get("/login-history", async (req: Request, res: Response): Promise<void> => {
  const identity = await callerIdentity(req);
  if (!identity) { res.json({ available: false, events: [] }); return; }
  try {
    const events = await listUserLoginEvents(identity.username, 25);
    res.json({ available: true, events });
  } catch {
    res.json({ available: false, events: [] });
  }
});

// ─── Email change (verified, self-service) ───────────────────────────────────
// Flow: request -> HMAC-signed token emailed to the NEW address -> user clicks
// the link (while signed in) -> verify updates GOTCHA + Authentik (email +
// username) with rollback if the IdP write fails. Stateless token (no model):
// base64url(JSON{userId, newEmail, exp}) + "." + hex(HMAC-SHA256).

const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000; // 1 hour
function b64url(s: string): string { return Buffer.from(s, "utf8").toString("base64url"); }
function unb64url(s: string): string { return Buffer.from(s, "base64url").toString("utf8"); }
function signEmailChange(payload: { userId: string; newEmail: string; exp: number }): string {
  const data = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", getOAuthStateSecret()).update(data).digest("hex");
  return `${data}.${sig}`;
}
function verifyEmailChange(token: string): { userId: string; newEmail: string; exp: number } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot), sig = token.slice(dot + 1);
  let expected: string;
  try { expected = crypto.createHmac("sha256", getOAuthStateSecret()).update(data).digest("hex"); } catch { return null; }
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  try {
    const p = JSON.parse(unb64url(data));
    if (!p.userId || !p.newEmail || !p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

router.post("/email-change", async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = (req.body?.newEmail ?? "").toString().trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) { res.status(400).json({ error: "invalid_email" }); return; }
    const me = await prisma.user.findUnique({
      where: { id: req.user!.userId }, select: { email: true, name: true, tenantId: true, identityId: true },
    });
    if (!me) { res.status(404).json({ error: "not_found" }); return; }
    if (raw === me.email.toLowerCase()) { res.status(400).json({ error: "same_email" }); return; }
    // An email change is IDENTITY-level (it renames the person everywhere).
    // Block when another identity already owns the address, or when any tenant
    // this person belongs to already has a different member using it.
    const identityClash = await prisma.identity.findFirst({
      where: { email: raw, id: { not: me.identityId } }, select: { id: true },
    });
    if (identityClash) { res.status(409).json({ error: "email_taken" }); return; }
    const myTenants = await withCrossTenantAccess(() => prisma.user.findMany({
      where: { identityId: me.identityId }, select: { tenantId: true },
    }));
    const clash = await prisma.user.findFirst({
      where: {
        tenantId: { in: myTenants.map((t) => t.tenantId) },
        email: raw,
        identityId: { not: me.identityId },
      },
      select: { id: true },
    });
    if (clash) { res.status(409).json({ error: "email_taken" }); return; }

    const token = signEmailChange({ userId: req.user!.userId, newEmail: raw, exp: Date.now() + EMAIL_CHANGE_TTL_MS });
    const base = resolveAppPublicUrl(process.env);
    const verifyUrl = `${base}/account/verify-email?token=${encodeURIComponent(token)}`;
    await sendEmailChangeVerification(raw, me.name, verifyUrl);

    void writeAudit({
      tenantId: me.tenantId, actorType: "user", actorId: req.user!.userId,
      action: AuditAction.EMAIL_CHANGE_REQUESTED, targetType: "user", targetId: req.user!.userId,
      metadata: { self: true, to: raw },
    });
    res.json({ sent: true });
  } catch (err: any) {
    console.error("[account] email-change request error:", err?.message);
    res.status(500).json({ error: "request_failed" });
  }
});

router.post("/email-change/verify", async (req: Request, res: Response): Promise<void> => {
  const token = (req.body?.token ?? "").toString();
  const payload = verifyEmailChange(token);
  if (!payload) { res.status(400).json({ error: "invalid_or_expired" }); return; }
  // Defense in depth: the signed-in user must be the same account the token was
  // issued for. This makes the emailed link unusable against a different account.
  if (payload.userId !== req.user!.userId) { res.status(403).json({ error: "wrong_account" }); return; }

  const me = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      email: true, tenantId: true, identityId: true,
      identity: { select: { email: true, authentikSubject: true } },
    },
  });
  if (!me) { res.status(404).json({ error: "not_found" }); return; }
  // Re-check uniqueness at confirm time (someone may have taken it meanwhile):
  // identity-level plus every tenant this person is a member of.
  const identityClash = await prisma.identity.findFirst({
    where: { email: payload.newEmail, id: { not: me.identityId } }, select: { id: true },
  });
  if (identityClash) { res.status(409).json({ error: "email_taken" }); return; }
  const myTenants = await withCrossTenantAccess(() => prisma.user.findMany({
    where: { identityId: me.identityId }, select: { tenantId: true },
  }));
  const clash = await prisma.user.findFirst({
    where: {
      tenantId: { in: myTenants.map((t) => t.tenantId) },
      email: payload.newEmail,
      identityId: { not: me.identityId },
    },
    select: { id: true },
  });
  if (clash) { res.status(409).json({ error: "email_taken" }); return; }

  const previousIdentityEmail = me.identity.email;
  // Identity master + every membership display mirror move together.
  await withCrossTenantAccess(() => prisma.$transaction([
    prisma.identity.update({ where: { id: me.identityId }, data: { email: payload.newEmail } }),
    prisma.user.updateMany({ where: { identityId: me.identityId }, data: { email: payload.newEmail } }),
  ]));

  // Sync Authentik email + username; roll GOTCHA back if the IdP write fails so
  // the two systems never diverge.
  try {
    if (me.identity.authentikSubject) {
      const identity = await findIdentityBySubject(me.identity.authentikSubject);
      if (identity) await updateIdentity(identity.pk, { email: payload.newEmail, username: payload.newEmail });
    }
  } catch (err: any) {
    await withCrossTenantAccess(() => prisma.$transaction([
      prisma.identity.update({ where: { id: me.identityId }, data: { email: previousIdentityEmail } }),
      prisma.user.updateMany({ where: { identityId: me.identityId }, data: { email: me.email } }),
    ]));
    console.error("[account] email-change IdP sync failed, rolled back:", err?.message);
    res.status(502).json({ error: "idp_sync_failed" });
    return;
  }

  void writeAudit({
    tenantId: me.tenantId, actorType: "user", actorId: payload.userId,
    action: AuditAction.EMAIL_CHANGE_CONFIRMED, targetType: "user", targetId: payload.userId,
    metadata: { self: true, from: me.email, to: payload.newEmail },
  });
  res.json({ ok: true, email: payload.newEmail });
});

export default router;
