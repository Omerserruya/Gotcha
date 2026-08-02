-- Hierarchical MFA enforcement policy.
--
-- Tenant-level opt-in flags (both default OFF so existing tenants are
-- unchanged) + a cheap local mirror of a user's MFA enrolment state so the
-- enforcement guard and Workspace compliance counts avoid an IdP call per
-- request. Authentik stays the source of truth for the actual factors.

ALTER TABLE "tenants"
  ADD COLUMN "mfa_required_for_admins" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfa_required_for_all_users" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users"
  ADD COLUMN "mfa_enrolled_at" TIMESTAMP(3);
