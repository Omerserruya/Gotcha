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
  listUserSourceConnections,
  deleteOAuthSourceConnection,
  readLatestSignIn,
  sameAuthentikId,
  deleteRecoveryToken,
  mfaRequirementFor,
  isEnrolledWithRecovery,
  isSupportedLocale,
  getOAuthStateSecret,
  LEGAL_VERSIONS,
  type RemovableDeviceType,
  resolveAppPublicUrl,
} from "@chatcenter/shared";
import { sendEmailChangeVerification } from "../services/notification.service";
import { googleSourceSlug, hasAnotherWayIn, emailChangeGoogleStep } from "../lib/google-sign-in";
import { acceptanceOf, termsConsentRows, TERMS_PURPOSE } from "../lib/terms-consent";

const router = Router();
router.use(authenticate);

/** Resolve the caller's Authentik pk (or null) from their identity's subject. */
async function callerIdentity(req: Request): Promise<{ pk: number; username: string; email: string; subject: string; uid?: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { identity: { select: { authentikSubject: true } } },
  });
  const subject = user?.identity?.authentikSubject;
  if (!subject) return null;
  const identity = await findIdentityBySubject(subject);
  return identity
    ? { pk: identity.pk, username: identity.username, email: identity.email, subject: identity.subject, uid: identity.uid }
    : null;
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
  } catch (err) {
    // IdP error: fail CLOSED for enforcement - trust only the stored stamp.
    enrolled = mfaStamp != null;
    // LOG it. This catch was silent, and silence here is expensive: the gate
    // blocks the entire app until it clears, so an unusable API token showed
    // up as an MFA popup that reappeared after every successful enrolment,
    // with nothing in any log to say why. The message carries the HTTP status
    // (see api() in packages/shared/lib/authentik.ts), which distinguishes the
    // two cases that matter - 401/403 means our credentials are wrong and no
    // amount of user retrying will help, anything else is likely transient.
    console.warn(
      `[mfa-gate] IdP lookup failed for identity=${user.identityId}; ` +
      `falling back to the stored stamp (enrolled=${enrolled}). ${(err as Error)?.message ?? err}`,
    );
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

// ─── Sign-in connections (Sign in with Google) ──────────────────────────────
//
// Authentik owns the connection: it makes one the first time a person signs in
// with Google, by an exact match on the email. Nothing here creates one, and
// nothing here signs anything. These two routes only show the caller their own
// connection and let them remove it.
//
// The one rule: a connection is never removed when it is the person's only way
// in. "Another way in" is a usable password or a connection to another source.
// When the password question cannot be answered (the IdP failed, or the policy
// that answers it is not set up) the answer is treated as "no password", so the
// doubt always falls on the side of keeping the person able to sign in.
// The rule itself lives in lib/google-sign-in, shared with the email change.

const GOOGLE_OFF = { available: false, connected: false, email: null, connectedAt: null, canDisconnect: false, reason: null };

router.get("/sign-in-connections", async (req: Request, res: Response): Promise<void> => {
  const slug = googleSourceSlug();
  if (!slug) { res.json({ google: GOOGLE_OFF }); return; }
  const identity = await callerIdentity(req);
  if (!identity) { res.status(409).json({ error: "no_identity" }); return; }
  try {
    const connections = await listUserSourceConnections(identity.pk);
    const google = connections.find((c) => c.sourceSlug === slug);
    if (!google) {
      res.json({ google: { ...GOOGLE_OFF, available: true } });
      return;
    }
    const canDisconnect = await hasAnotherWayIn(identity.pk, connections.length - 1);
    res.json({
      google: {
        available: true,
        connected: true,
        // A connection carries no address of its own. It was made by matching
        // this one, so this is the address the Google account answers to.
        email: identity.email,
        connectedAt: google.createdAt,
        canDisconnect,
        reason: canDisconnect ? null : "no_other_sign_in",
      },
    });
  } catch {
    res.status(502).json({ error: "idp_unavailable" });
  }
});

router.delete("/sign-in-connections/google", async (req: Request, res: Response): Promise<void> => {
  const slug = googleSourceSlug();
  if (!slug) { res.status(404).json({ error: "not_available" }); return; }
  const identity = await callerIdentity(req);
  if (!identity) { res.status(409).json({ error: "no_identity" }); return; }
  try {
    // The id that gets deleted is read from the caller's own list, never from
    // the request: there is nothing in the URL to point at someone else's.
    const connections = await listUserSourceConnections(identity.pk);
    const google = connections.find((c) => c.sourceSlug === slug);
    if (!google) { res.status(404).json({ error: "not_connected" }); return; }
    if (!(await hasAnotherWayIn(identity.pk, connections.length - 1))) {
      res.status(409).json({ error: "no_other_sign_in" });
      return;
    }
    await deleteOAuthSourceConnection(google.id);
    void writeAudit({
      tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId,
      action: AuditAction.SIGN_IN_CONNECTION_REMOVED, targetType: "user", targetId: req.user!.userId,
      metadata: { self: true, provider: "google" },
    });
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "idp_unavailable" });
  }
});

// ─── The sign-in that just happened ──────────────────────────────────────────
//
// Authentik signs people in; GOTCHA only writes down that it happened. The
// app's sign-in callback calls this once, with the new access token, right
// after Authentik hands it over. It signs nothing, and it never stands between
// a person and their session: every step is best effort, and the answer is
// always a 200.
//
// What it does, each part on its own:
//   1. Reads from Authentik HOW the person came in (its newest login event),
//      and writes one audit line per sign-in, counted by that event's id.
//   2. After a Google sign-in, writes "connection added" the first time this
//      connection is seen, counted by the connection's id.
//   3. Marks the person's live setup links as used: they are in, so an
//      invitation still sitting in their inbox has done its job.
//   4. After a new Google sign-in, removes the one-time "set a password" token
//      Authentik may still hold for them from the setup screen.
//   5. Answers the "connect Google" question when the callback carries one.
//   6. Says whether the Terms screen stands before the app (`termsRequired`,
//      the section below).

type SignInMethod = "google" | "password" | "unknown";
type ConnectVerdict = "connected" | "other_account" | null;

/** With no login event to count by, at most one sign-in line per person in this window. */
const SIGN_IN_NO_EVENT_WINDOW_MS = 60_000;

/** Run one best-effort step. A failure is logged and never reaches the caller. */
async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err: any) { console.warn(`[sign-in] ${what} failed: ${err?.message ?? err}`); }
}

/** A date Authentik gave, or undefined when it is not one. */
function dateOf(iso: string | null | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * How the person came in. A sign-in through an outside source is "google" only
 * when that source is the one their Google connection belongs to; through any
 * other source it is "unknown", never "password".
 */
function signInMethod(
  signIn: { sourcePk: string | null; byPassword: boolean } | null,
  google: { sourcePk: string } | undefined,
): SignInMethod {
  if (!signIn) return "unknown";
  if (signIn.sourcePk) return google && sameAuthentikId(signIn.sourcePk, google.sourcePk) ? "google" : "unknown";
  return signIn.byPassword ? "password" : "unknown";
}

/**
 * The answer to "I pressed Connect Google as person X, then signed in": the
 * same person came back through Google ("connected"), or Google signed in
 * somebody else ("other_account"). Anything that was not a Google sign-in is
 * no answer at all: a password sign-in by another person on a shared machine
 * says nothing about the connect that was started there.
 */
function connectVerdict(method: SignInMethod, callerSubject: string, connectSubject: unknown): ConnectVerdict {
  if (method !== "google") return null;
  if (typeof connectSubject !== "string" || !connectSubject.trim() || connectSubject.length > 128) return null;
  return sameAuthentikId(connectSubject, callerSubject) ? "connected" : "other_account";
}

/**
 * The caller's newest sign-in, as Authentik has it. Lenient by default: a read
 * that fails is "unknown", because the sign-in record never stands in a
 * person's way. `strict` lets the failure through, for the one caller that
 * must tell "could not ask" from "not Google".
 */
async function latestSignInOf(req: Request, strict = false) {
  const slug = googleSourceSlug();
  const read = <T>(p: Promise<T>, fallback: T): Promise<T> => (strict ? p : p.catch(() => fallback));
  const identity = await read(callerIdentity(req), null);
  const [connections, signIn] = identity
    ? await Promise.all([
        slug ? read(listUserSourceConnections(identity.pk), []) : Promise.resolve([]),
        read(readLatestSignIn(identity.pk, identity.username), null),
      ])
    : [[], null];
  const google = slug ? connections.find((c) => c.sourceSlug === slug) : undefined;
  return { identity, google, signIn, method: signInMethod(signIn, google) };
}

/**
 * Every membership row of the caller. One person can hold one in several
 * workspaces; what is written under any of them is theirs. The caller's own
 * row is always in the list, also when the others cannot be read.
 */
async function callerMemberships(req: Request): Promise<{ id: string; tenantId: string }[]> {
  const { userId, tenantId, identityId } = req.user!;
  const rows = identityId
    ? await withCrossTenantAccess(() => prisma.user.findMany({ where: { identityId }, select: { id: true, tenantId: true } })).catch(() => [])
    : [];
  return [{ id: userId, tenantId }, ...rows.filter((r) => r.id !== userId)];
}

/**
 * Whether an acceptance of the Terms is on file for this person, under any of
 * their memberships. Throws when the ledger cannot be read: a failed read is
 * never "accepted" and never "not accepted".
 */
async function termsAccepted(memberships: { id: string; tenantId: string }[]): Promise<boolean> {
  const row = await withCrossTenantAccess(() => prisma.consentRecord.findFirst({
    where: {
      subjectType: "user",
      purpose: TERMS_PURPOSE,
      granted: true,
      OR: memberships.map((m) => ({ tenantId: m.tenantId, subjectId: m.id })),
    },
    select: { id: true },
  }));
  return !!row;
}

router.post("/security/sign-in", async (req: Request, res: Response): Promise<void> => {
  const answer: { method: SignInMethod; google: ConnectVerdict; termsRequired: boolean } = { method: "unknown", google: null, termsRequired: false };
  if ((req.user as any)?.isInternal) { res.json(answer); return; }
  const { userId, tenantId } = req.user!;
  try {
    const { identity, google, signIn, method } = await latestSignInOf(req);
    answer.method = method;
    if (identity) answer.google = connectVerdict(answer.method, identity.subject, req.body?.connectSubject);

    // A line written under any of the person's memberships counts as written,
    // and a link issued for any of them is theirs.
    const memberships = await callerMemberships(req);
    const userIds = memberships.map((m) => m.id);
    const now = new Date();

    // Only a sign-in KNOWN to be Google asks for the Terms. Once it is, a ledger
    // that cannot be read asks too: the screen's own endpoints read it again, and
    // an acceptance already on file is never written twice.
    if (answer.method === "google") {
      answer.termsRequired = await termsAccepted(memberships).then((on) => !on, (err: any) => {
        console.warn(`[sign-in] terms read failed: ${err?.message ?? err}`);
        return true;
      });
    }

    // Counted first: whether this sign-in is NEW decides the token step below. A
    // callback can also arrive with no new sign-in behind it (the app session
    // ended, Authentik's did not), and then the newest login event is an old one.
    let newSignIn = false;
    await quietly("audit", async () => {
      const seen = await withCrossTenantAccess(() => prisma.auditLog.findFirst({
        where: {
          action: AuditAction.AUTH_LOGIN_SUCCEEDED,
          actorId: { in: userIds },
          ...(signIn
            ? { metadata: { path: ["loginEventId"], equals: signIn.eventId } }
            : { createdAt: { gte: new Date(now.getTime() - SIGN_IN_NO_EVENT_WINDOW_MS) } }),
        },
        select: { id: true },
      }));
      if (seen) return;
      await writeAudit({
        tenantId, actorType: "user", actorId: userId,
        action: AuditAction.AUTH_LOGIN_SUCCEEDED, targetType: "user", targetId: userId,
        metadata: { method: answer.method, ...(signIn ? { loginEventId: signIn.eventId } : {}) },
        at: dateOf(signIn?.at),
      });
      newSignIn = true;
    });

    await Promise.all([
      quietly("connection audit", async () => {
        if (answer.method !== "google" || !google) return;
        const seen = await withCrossTenantAccess(() => prisma.auditLog.findFirst({
          where: {
            action: AuditAction.SIGN_IN_CONNECTION_ADDED,
            actorId: { in: userIds },
            metadata: { path: ["connectionId"], equals: google.id },
          },
          select: { id: true },
        }));
        if (seen) return;
        await writeAudit({
          tenantId, actorType: "user", actorId: userId,
          action: AuditAction.SIGN_IN_CONNECTION_ADDED, targetType: "user", targetId: userId,
          metadata: { self: true, provider: "google", connectionId: google.id },
          at: dateOf(google.createdAt),
        });
      }),
      quietly("setup links", () => withCrossTenantAccess(() => prisma.setupLink.updateMany({
        where: { userId: { in: userIds }, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      }))),
      quietly("recovery token", async () => {
        // Only for a Google sign-in seen here for the first time: a password link the
        // person asked for AFTER an old Google sign-in is theirs to use.
        if (!newSignIn || answer.method !== "google" || !identity?.uid) return;
        await deleteRecoveryToken(identity.uid);
      }),
    ]);
  } catch (err: any) {
    console.warn(`[sign-in] record failed: ${err?.message ?? err}`);
  }
  res.json(answer);
});

// ─── The Terms, before first entry with Google ───────────────────────────────
//
// A person who sets a first password accepts the Terms on that screen (the
// setup link). A person who comes in with Google never sees that screen, so
// the app shows them the Terms before anything else (Omer, 2026-11-22).
//
// The rule, in one line: the newest sign-in is a Google one AND no acceptance
// of the Terms is on file for the person, under any of their memberships.
// Nobody who signs in with a password is ever asked here, whenever their
// password was set.
//
// The app's shell obeys `termsRequired`; no other route refuses on it.
//   POST /security/sign-in   carries the flag at sign-in
//   GET  /terms              the same flag again, for a reload
//   POST /terms/accept       records the acceptance: the two rows the setup
//                            screen writes, with source "google_first_sign_in"

/** A service call or a support session is never the person's own entry. */
function notThePersonThemself(req: Request): boolean {
  return !!(req.user as any)?.isInternal || !!(req.user as any)?.support;
}

/**
 * GET /terms -> 200 { termsRequired } | 503 { error: "unavailable" }.
 * The ledger is read first: with an acceptance on file nothing is asked of
 * Authentik. 503 means the question could not be answered, never "no".
 */
router.get("/terms", async (req: Request, res: Response): Promise<void> => {
  if (notThePersonThemself(req) || !googleSourceSlug()) { res.json({ termsRequired: false }); return; }
  try {
    if (await termsAccepted(await callerMemberships(req))) { res.json({ termsRequired: false }); return; }
    const { method } = await latestSignInOf(req, true);
    res.json({ termsRequired: method === "google" });
  } catch (err: any) {
    console.warn(`[terms] read failed: ${err?.message ?? err}`);
    res.status(503).json({ error: "unavailable" });
  }
});

/**
 * POST /terms/accept, body { terms: true, privacy: true, locale, capturedText }.
 *   200 { termsRequired: false }      recorded now, or already on file (nothing written again)
 *   400 { error: "consent_required" } either box not exactly true; nothing written
 *   403 { error: "forbidden" }        not the person themself
 *   503 { error: "unavailable" }      the ledger could not be read or written; nothing is claimed
 *
 * Both rows go in one transaction, under the membership the person is in now.
 * How they signed in is kept in the evidence as it was read, not assumed.
 */
router.post("/terms/accept", async (req: Request, res: Response): Promise<void> => {
  if (notThePersonThemself(req)) { res.status(403).json({ error: "forbidden" }); return; }
  const accepted = acceptanceOf(req.body);
  if (!accepted) { res.status(400).json({ error: "consent_required" }); return; }
  const { userId, tenantId } = req.user!;
  const source = "google_first_sign_in" as const;
  try {
    if (await termsAccepted(await callerMemberships(req))) { res.json({ termsRequired: false }); return; }
    const { method } = await latestSignInOf(req);
    const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    const rows = termsConsentRows({
      tenantId, userId, source, locale: accepted.locale,
      evidence: {
        ip: fwd || req.ip || null,
        userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null,
        capturedText: accepted.capturedText,
        locale: accepted.locale,
        channel: "sign_in",
        signInMethod: method,
        acceptedAt: new Date().toISOString(),
      },
    });
    await prisma.$transaction(rows.map((data) => prisma.consentRecord.create({ data })));
    void writeAudit({
      tenantId, actorType: "user", actorId: userId,
      action: AuditAction.CONSENT_GRANTED, targetType: "user", targetId: userId,
      metadata: { purposes: rows.map((r) => r.purpose), versions: LEGAL_VERSIONS, source, locale: accepted.locale },
    });
    res.json({ termsRequired: false });
  } catch (err: any) {
    console.error("[terms] accept failed:", err?.message ?? err);
    res.status(503).json({ error: "unavailable" });
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

    // A changed email removes the Google connection (see verify). When that
    // would leave the person no way in, say so now, before a link is mailed.
    // Verify asks again and is the authority, so an identity that cannot be
    // read here is not a refusal.
    if (googleSourceSlug()) {
      const idp = await callerIdentity(req).catch(() => null);
      const step = idp ? await emailChangeGoogleStep(idp.pk).catch(() => null) : null;
      if (step?.state === "blocked") { res.status(409).json({ error: "no_other_sign_in" }); return; }
    }

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

  // The Google connection was made by matching the OLD address, so it goes when
  // the address changes, and the change is refused while it is the person's
  // only way in (lib/google-sign-in). It goes FIRST: if the change then fails,
  // the person still has their other way in and can connect again. The other
  // order could leave the old Google account opening an account that now
  // carries a new address.
  let googleDisconnected = false;
  if (googleSourceSlug() && me.identity.authentikSubject) {
    try {
      const idp = await findIdentityBySubject(me.identity.authentikSubject);
      const step = idp ? await emailChangeGoogleStep(idp.pk) : null;
      if (step?.state === "blocked") { res.status(409).json({ error: "no_other_sign_in" }); return; }
      if (step?.state === "remove") {
        await deleteOAuthSourceConnection(step.connectionId);
        googleDisconnected = true;
        void writeAudit({
          tenantId: me.tenantId, actorType: "user", actorId: payload.userId,
          action: AuditAction.SIGN_IN_CONNECTION_REMOVED, targetType: "user", targetId: payload.userId,
          metadata: { self: true, provider: "google", reason: "email_change" },
        });
      }
    } catch (err: any) {
      console.error("[account] email-change: the Google connection could not be read or removed, nothing changed:", err?.message);
      res.status(502).json({ error: "idp_sync_failed" });
      return;
    }
  }

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
    // The email is back as it was; a Google connection that was removed is not.
    res.status(502).json({ error: "idp_sync_failed", ...(googleDisconnected ? { googleDisconnected: true } : {}) });
    return;
  }

  void writeAudit({
    tenantId: me.tenantId, actorType: "user", actorId: payload.userId,
    action: AuditAction.EMAIL_CHANGE_CONFIRMED, targetType: "user", targetId: payload.userId,
    metadata: { self: true, from: me.email, to: payload.newEmail, ...(googleDisconnected ? { googleDisconnected: true } : {}) },
  });
  res.json({ ok: true, email: payload.newEmail, googleDisconnected });
});

export default router;
