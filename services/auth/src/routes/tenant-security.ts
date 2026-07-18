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
  requireRole,
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
  return prisma.user.findMany({
    where: { tenantId },
    select: { id: true, name: true, email: true, role: true, authentikSubject: true, mfaEnrolledAt: true, isActive: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
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
        void prisma.user.update({ where: { id: m.id }, data: { mfaEnrolledAt: new Date() } }).catch(() => {});
      } else if (!live.enrolled && m.mfaEnrolledAt) {
        void prisma.user.update({ where: { id: m.id }, data: { mfaEnrolledAt: null } }).catch(() => {});
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
router.get("/", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
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
router.patch("/", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
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
router.get("/review", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
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
