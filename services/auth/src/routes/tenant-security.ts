/**
 * Workspace security policy (Workspace -> Security).
 *
 * A TENANT ADMIN sets the hierarchical MFA policy for their workspace here and
 * sees live compliance. SYSTEM_ADMIN protection is a platform requirement and
 * is NOT represented as a toggle - it is always on and reported as such.
 *
 * Enforcement itself lives in the account /mfa-gate + the frontend gate; this
 * route only owns the policy flags and the compliance/roster view.
 */

import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requirePermissionOrRole,
  writeAudit,
  AuditAction,
  mfaRequirementFor,
  getMfaEnrollmentMap,
  type MfaEnrollmentState,
} from "@chatcenter/shared";

const router = Router();
router.use(authenticate, resolveTenant);

/** Members of the tenant that matter for MFA (real people who can sign in). */
async function tenantMembers(tenantId: string) {
  const rows = await prisma.user.findMany({
    where: { tenantId },
    select: {
      id: true, name: true, email: true, role: true, isActive: true,
      identity: { select: { id: true, authentikSubject: true, mfaEnrolledAt: true } },
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  // Flatten the identity-level fields the rest of this module keys on.
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, role: r.role, isActive: r.isActive,
    identityId: r.identity.id,
    authentikSubject: r.identity.authentikSubject,
    mfaEnrolledAt: r.identity.mfaEnrolledAt,
  }));
}

const isAdminRole = (role: string) => role === "ADMIN" || role === "SYSTEM_ADMIN";

/**
 * Build compliance + per-member roster from the live IdP enrolment state.
 * One bounded bulk read (getMfaEnrollmentMap) regardless of member count. Also
 * refreshes the local `mfaEnrolledAt` mirror so the enforcement guard agrees
 * with what an admin sees here.
 */
async function buildCompliance(tenantId: string) {
  const members = await tenantMembers(tenantId);
  const subjects = members.map((m) => m.authentikSubject).filter((s): s is string => !!s);
  let enrollMap = new Map<string, MfaEnrollmentState>();
  let idpAvailable = true;
  try {
    enrollMap = await getMfaEnrollmentMap(subjects);
  } catch {
    idpAvailable = false;
  }

  const roster = members.map((m) => {
    const live = m.authentikSubject ? enrollMap.get(m.authentikSubject) : undefined;
    // Use a live reading only when the subject was actually resolved+read.
    // Otherwise (IdP down, or subject not resolvable) fall back to the stored
    // stamp so the roster stays truthful instead of showing "everyone
    // unprotected" on a lookup miss.
    const enrolled = live?.resolved ? live.enrolled : (m.mfaEnrolledAt != null);
    return {
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      isActive: m.isActive,
      hasAuthenticator: live?.resolved ? live.hasAuthenticator : false,
      hasRecovery: live?.resolved ? live.hasRecovery : false,
      enrolled,
    };
  });

  // Keep the local mirror in step with the live read (best-effort, non-blocking).
  // Only act on a DEFINITIVE reading (resolved) - never clear a stamp because a
  // subject couldn't be looked up (Finding 4: that would silently downgrade an
  // enrolled user whose identity was missing from the bulk list / page cutoff).
  if (idpAvailable) {
    for (const m of members) {
      const live = m.authentikSubject ? enrollMap.get(m.authentikSubject) : undefined;
      if (!live?.resolved) continue;
      if (live.enrolled && !m.mfaEnrolledAt) {
        void prisma.identity.update({ where: { id: m.identityId }, data: { mfaEnrolledAt: new Date() } }).catch(() => {});
      } else if (!live.enrolled && m.mfaEnrolledAt) {
        void prisma.identity.update({ where: { id: m.identityId }, data: { mfaEnrolledAt: null } }).catch(() => {});
      }
    }
  }

  const admins = roster.filter((r) => isAdminRole(r.role));
  const all = roster; // "Users" = the whole workspace, admins included.
  return {
    idpAvailable,
    compliance: {
      admins: { protected: admins.filter((r) => r.enrolled).length, total: admins.length },
      users: { protected: all.filter((r) => r.enrolled).length, total: all.length },
    },
    roster,
  };
}

// GET current policy + compliance. Any workspace admin may view.
/**
 * GET /api/tenant/security/session-policy - what Authentik is configured to do,
 * READ-ONLY.
 *
 * NO CONTROL, DELIBERATELY. Session lifetime belongs to Authentik; GOTCHA
 * implements none of it. A toggle here would either edit a global Authentik
 * stage from a tenant screen or, worse, write a GOTCHA-side value that nothing
 * enforces - a control that reports success while changing nothing.
 *
 * ★ IT IS PLATFORM-WIDE, NOT PER-TENANT, AND SAYS SO. There is one
 * `default-authentication-login` stage for the whole deployment, so these
 * numbers are the same for every tenant. Rendered on a tenant's Security screen
 * without that sentence, an admin reads them as their own setting and as
 * something they could ask to have changed for them alone.
 *
 * NEITHER VALUE IS AN INACTIVITY TIMEOUT, which is the thing a reader assumes a
 * "session policy" means. Authentik measures ABSOLUTE duration:
 *   session_duration "seconds=0"  the session ends when the browser session
 *                                 does. It is NOT "expires immediately", which
 *                                 is what the raw string looks like.
 *   remember_me_offset "days=30"  how long "remember me" survives, absolute -
 *                                 30 days whether or not anyone signs in.
 * Both are returned raw AND described, because the raw value alone is
 * misleading and the description alone is unverifiable.
 *
 * Fail-soft: Authentik unreachable returns `available: false` with the reason.
 * A settings screen that invents a plausible default is worse than one that
 * admits it could not ask.
 */
router.get(
  "/session-policy",
  requirePermissionOrRole("settings:workspace:update", "ADMIN"),
  async (_req: Request, res: Response): Promise<void> => {
    const base = process.env.AUTHENTIK_URL;
    const token = process.env.AUTHENTIK_API_TOKEN || process.env.AUTHENTIK_BOOTSTRAP_TOKEN;
    if (!base || !token) {
      res.json({
        data: {
          available: false,
          reason: "Authentik is not configured for this deployment, so its session policy cannot be read.",
          scope: "platform",
        },
      });
      return;
    }

    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/api/v3/stages/user_login/`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`authentik ${r.status}`);
      const body: any = await r.json();
      // The stage the dashboard login actually uses. The other two are for
      // source-based enrolment and do not govern a normal sign-in, so reporting
      // the first result would be right by accident and wrong when it is not.
      const stage = (body?.results ?? []).find((x: any) => x?.name === "default-authentication-login");
      if (!stage) throw new Error("default-authentication-login stage not found");

      const sessionDuration = String(stage.session_duration ?? "");
      const rememberMe = String(stage.remember_me_offset ?? "");

      /**
       * Authentik stores these as "days=30" / "seconds=0". Putting that token
       * straight into a sentence produces "lasts days=30 from sign-in", which
       * is how the first version read - correct data, unreadable to the person
       * the sentence is for. The raw value is still returned beside it.
       */
      const human = (v: string): string => {
        const m = /^(\w+)=(\d+)$/.exec(v);
        if (!m) return v;
        const n = Number(m[2]);
        const unit = m[1]!.replace(/s$/, "");
        return `${n} ${unit}${n === 1 ? "" : "s"}`;
      };
      res.json({
        data: {
          available: true,
          scope: "platform",
          managedBy: "authentik",
          editableHere: false,
          sessionDuration: {
            raw: sessionDuration,
            meaning:
              sessionDuration === "seconds=0"
                ? "The session ends when the browser session ends. It is not an inactivity timeout and does not expire while the browser stays open."
                : `Sessions last ${human(sessionDuration)} from sign-in, regardless of activity.`,
          },
          rememberMe: {
            raw: rememberMe,
            meaning:
              rememberMe === "seconds=0"
                ? "Remember-me is off."
                : `"Remember me" lasts ${human(rememberMe)} from sign-in, regardless of activity.`,
          },
          inactivityTimeout: {
            supported: false,
            meaning:
              "Authentik measures absolute session duration, not idle time, so there is no inactivity timeout to report.",
          },
        },
      });
    } catch (err: any) {
      res.json({
        data: {
          available: false,
          scope: "platform",
          reason: `Authentik did not answer, so the live session policy is unknown: ${err?.message ?? "unknown error"}`,
        },
      });
    }
  },
);

router.get("/", requirePermissionOrRole("settings:workspace:update", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId || req.user!.tenantId;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true },
  });
  if (!tenant) { res.status(404).json({ error: "not_found" }); return; }
  const { compliance, idpAvailable } = await buildCompliance(tenantId);
  res.json({
    policy: {
      mfaRequiredForAdmins: tenant.mfaRequiredForAdmins,
      mfaRequiredForAllUsers: tenant.mfaRequiredForAllUsers,
    },
    systemAdminAlways: true,
    idpAvailable,
    compliance,
  });
});

// PATCH policy flags. Enabling never locks out already-enrolled members; the
// backfill stamps them compliant, and only the un-enrolled get gated.
router.patch("/", requirePermissionOrRole("settings:workspace:update", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId || req.user!.tenantId;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: { mfaRequiredForAdmins?: boolean; mfaRequiredForAllUsers?: boolean } = {};
  if (typeof body.mfaRequiredForAdmins === "boolean") data.mfaRequiredForAdmins = body.mfaRequiredForAdmins;
  if (typeof body.mfaRequiredForAllUsers === "boolean") data.mfaRequiredForAllUsers = body.mfaRequiredForAllUsers;
  if (Object.keys(data).length === 0) { res.status(400).json({ error: "no_fields" }); return; }

  const before = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true },
  });
  if (!before) { res.status(404).json({ error: "not_found" }); return; }

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data,
    select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true },
  });

  // Refresh compliance (this also backfills mfaEnrolledAt for enrolled members
  // so turning a policy ON doesn't push compliant users back through setup).
  const { compliance, idpAvailable } = await buildCompliance(tenantId);

  void writeAudit({
    tenantId, actorType: "user", actorId: req.user!.userId,
    action: AuditAction.MFA_POLICY_CHANGED, targetType: "tenant", targetId: tenantId,
    metadata: { before, after: updated },
  });

  res.json({ policy: updated, systemAdminAlways: true, idpAvailable, compliance });
});

// GET the per-member roster ("Review users" - who still needs MFA).
router.get("/review", requirePermissionOrRole("settings:workspace:update", "ADMIN"), async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId || req.user!.tenantId;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true },
  });
  if (!tenant) { res.status(404).json({ error: "not_found" }); return; }
  const policy = { mfaRequiredForAdmins: tenant.mfaRequiredForAdmins, mfaRequiredForAllUsers: tenant.mfaRequiredForAllUsers };
  const { roster, idpAvailable } = await buildCompliance(tenantId);
  const members = roster.map((m) => {
    const req = mfaRequirementFor(m.role, policy);
    return { ...m, required: req.required, requirementReason: req.reason, compliant: !req.required || m.enrolled };
  });
  res.json({ idpAvailable, members });
});

export default router;
