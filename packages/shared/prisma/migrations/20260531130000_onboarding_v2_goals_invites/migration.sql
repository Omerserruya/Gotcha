-- Onboarding v2 — adds multi-select goals to BusinessProfile and a
-- minimal TenantInvite model for the new "invite teammates" step.
--
-- Idempotent (IF NOT EXISTS) so it is safe to re-run on environments
-- where someone added these out-of-band via `prisma db push`.

ALTER TABLE "business_profiles" ADD COLUMN IF NOT EXISTS "business_goals" JSONB;
ALTER TABLE "business_profiles" ADD COLUMN IF NOT EXISTS "website_domain" TEXT;

CREATE TABLE IF NOT EXISTS "tenant_invites" (
  "id"          TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "token"       TEXT NOT NULL,
  "email"       TEXT,
  "role"        TEXT NOT NULL DEFAULT 'AGENT',
  "invited_by"  TEXT,
  "expires_at"  TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "user_id"     TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_invites_token_key" ON "tenant_invites"("token");
CREATE INDEX IF NOT EXISTS "tenant_invites_tenant_id_idx" ON "tenant_invites"("tenant_id");
CREATE INDEX IF NOT EXISTS "tenant_invites_email_idx" ON "tenant_invites"("email");

DO $$ BEGIN
  ALTER TABLE "tenant_invites"
    ADD CONSTRAINT "tenant_invites_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
