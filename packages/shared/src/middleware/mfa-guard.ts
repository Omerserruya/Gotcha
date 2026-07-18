import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { mfaRequirementFor } from "../lib/mfa";

/**
 * API-level MFA enforcement (defense in depth for the client enrolment gate).
 *
 * Mount AFTER `authenticate` on a protected router. When the caller's role +
 * their tenant's policy REQUIRE MFA and they have not enrolled, this 403s with a
 * machine-readable `mfa_enrollment_required` so a determined user can't bypass
 * the React gate by calling the API directly (curl / devtools / script).
 *
 * Design constraints:
 *   - It does NOT touch `authenticate()` (the sacred, fail-closed auth gate) and
 *     makes NO IdP call on the hot path. It reads only the local mirror
 *     (`User.mfaEnrolledAt`) + the tenant policy in one indexed query, then
 *     defers to the pure `mfaRequirementFor` policy.
 *   - Internal service principals (`isInternal`) and unauthenticated requests
 *     pass through untouched - the former have no human to enrol, the latter are
 *     already handled by `authenticate`.
 *   - `mfaEnrolledAt` is kept honest by the account `/mfa-gate` check and the
 *     Workspace compliance sweep. A user who just enrolled but hasn't had the
 *     gate stamp them yet could see ONE spurious 403 until the next stamp; the
 *     client re-checks and stamps on load, so this self-heals in seconds.
 *
 * On a local DB error it FAILS OPEN (calls next) rather than locking every user
 * out of the product on a transient blip - the client gate remains the primary
 * UX enforcement and the next request re-evaluates.
 */
export function enforceMfaEnrollment(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    void guard(req, res, next);
  };
}

async function guard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = (req as any).user;
  // No principal (public route reached before auth) or an internal service call:
  // nothing to enforce here.
  if (!user || user.isInternal || !user.userId || user.userId === "system") {
    next();
    return;
  }
  try {
    const row = await prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        role: true,
        mfaEnrolledAt: true,
        tenant: { select: { mfaRequiredForAdmins: true, mfaRequiredForAllUsers: true } },
      },
    });
    if (!row) { next(); return; }
    const requirement = mfaRequirementFor(row.role, {
      mfaRequiredForAdmins: row.tenant.mfaRequiredForAdmins,
      mfaRequiredForAllUsers: row.tenant.mfaRequiredForAllUsers,
    });
    if (requirement.required && row.mfaEnrolledAt == null) {
      res.status(403).json({ error: "mfa_enrollment_required", reason: requirement.reason });
      return;
    }
    next();
  } catch {
    // Local DB blip: don't lock the whole product; the client gate still applies.
    next();
  }
}
