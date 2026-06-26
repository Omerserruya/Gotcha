-- RBAC Phase 0: independent Scope dimension + built-in role identity.
-- Additive only — no behavior change until enforcement (P2) is wired.
-- Idempotent so it is safe on a dev DB that may lag the schema.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PermissionScope" AS ENUM ('OWN', 'TEAM', 'DEPARTMENT', 'WORKSPACE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable: tenant_roles — stable built-in key + default data-reach scope
ALTER TABLE "tenant_roles" ADD COLUMN IF NOT EXISTS "builtin_key" TEXT;
ALTER TABLE "tenant_roles" ADD COLUMN IF NOT EXISTS "default_scope" "PermissionScope" NOT NULL DEFAULT 'OWN';

-- AlterTable: user_role_assignments — per-assignment scope override (nullable = inherit role default)
ALTER TABLE "user_role_assignments" ADD COLUMN IF NOT EXISTS "scope" "PermissionScope";
