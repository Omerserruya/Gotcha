/**
 * Hierarchical MFA enforcement policy (pure, no I/O).
 *
 * The rule the whole platform derives enforcement from. Kept free of Prisma /
 * Authentik so it can be unit-tested and reused by the account gate, the
 * enforcement guard, and the Workspace compliance view without pulling in a DB
 * or an IdP client.
 *
 * Hierarchy:
 *   SYSTEM_ADMIN  -> MFA is ALWAYS mandatory (platform security requirement,
 *                    not tenant-configurable).
 *   ADMIN         -> mandatory when the tenant enabled EITHER
 *                    `mfaRequiredForAdmins` or `mfaRequiredForAllUsers`.
 *   AGENT (other) -> mandatory only when `mfaRequiredForAllUsers` is on.
 *
 * "Enrolled" means the user has BOTH an authenticator (TOTP or passkey) AND
 * recovery codes - recovery codes are required so a lost device can't lock a
 * user out of a workspace that mandates MFA.
 */

export type MfaRole = "SYSTEM_ADMIN" | "ADMIN" | "AGENT" | (string & {});

export interface TenantMfaPolicy {
  mfaRequiredForAdmins: boolean;
  mfaRequiredForAllUsers: boolean;
}

export type MfaRequirementReason =
  | "system_admin"
  | "tenant_admins"
  | "all_users"
  | null;

export interface MfaRequirement {
  required: boolean;
  reason: MfaRequirementReason;
}

/** Whether MFA is mandatory for a user, given their role + their tenant policy. */
export function mfaRequirementFor(role: MfaRole, policy: TenantMfaPolicy): MfaRequirement {
  if (role === "SYSTEM_ADMIN") return { required: true, reason: "system_admin" };
  if (role === "ADMIN") {
    if (policy.mfaRequiredForAdmins) return { required: true, reason: "tenant_admins" };
    if (policy.mfaRequiredForAllUsers) return { required: true, reason: "all_users" };
    return { required: false, reason: null };
  }
  // AGENT and any other non-privileged role.
  if (policy.mfaRequiredForAllUsers) return { required: true, reason: "all_users" };
  return { required: false, reason: null };
}

/** Minimal shape of an Authentik security summary for enrolment checks. */
export interface MfaFactorCounts {
  totp?: unknown[];
  passkeys?: unknown[];
  recoveryCodes?: unknown[];
}

/** Has an authenticator (TOTP or passkey) AND recovery codes. */
export function isEnrolledWithRecovery(s: MfaFactorCounts): boolean {
  const hasAuthenticator = (s.totp?.length ?? 0) > 0 || (s.passkeys?.length ?? 0) > 0;
  const hasRecovery = (s.recoveryCodes?.length ?? 0) > 0;
  return hasAuthenticator && hasRecovery;
}
