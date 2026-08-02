-- Identity & Membership model (multi-tenant identity).
--
-- Before: users.authentik_subject was globally UNIQUE, so one Authentik
-- identity could belong to exactly one tenant. After: an `identities` table
-- holds the person (subject / canonical email / name / MFA stamp) and each
-- `users` row becomes ONE TENANT MEMBERSHIP of an identity.
--
-- Fully automatic backfill: one identity per distinct lower(email), membership
-- rows re-pointed at it. Guarded so ambiguous data aborts the migration
-- instead of silently mis-linking people.

-- ── Guards ──────────────────────────────────────────────────────────────────
DO $$
DECLARE bad integer;
BEGIN
  -- Two different Authentik subjects sharing an email would collapse into one
  -- identity and lock the second person out. Abort loudly.
  SELECT count(*) INTO bad FROM (
    SELECT lower(email) FROM users WHERE authentik_subject IS NOT NULL
    GROUP BY lower(email) HAVING count(DISTINCT authentik_subject) > 1
  ) t;
  IF bad > 0 THEN
    RAISE EXCEPTION 'identity migration aborted: % email(s) map to multiple Authentik subjects', bad;
  END IF;

  -- Two users in the SAME tenant with the same email (case-variant) would
  -- violate the new (tenant_id, identity_id) uniqueness.
  SELECT count(*) INTO bad FROM (
    SELECT tenant_id, lower(email) FROM users
    GROUP BY tenant_id, lower(email) HAVING count(*) > 1
  ) t;
  IF bad > 0 THEN
    RAISE EXCEPTION 'identity migration aborted: % duplicate (tenant,email) pair(s)', bad;
  END IF;
END $$;

-- ── identities ──────────────────────────────────────────────────────────────
CREATE TABLE "identities" (
    "id" TEXT NOT NULL,
    "authentik_subject" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mfa_enrolled_at" TIMESTAMP(3),
    "last_tenant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identities_authentik_subject_key" ON "identities"("authentik_subject");
CREATE UNIQUE INDEX "identities_email_key" ON "identities"("email");

-- ── Backfill: one identity per person (keyed by lower(email)) ───────────────
INSERT INTO "identities" (id, authentik_subject, email, name, mfa_enrolled_at, last_tenant_id, created_at, updated_at)
SELECT
    gen_random_uuid()::text,
    max(u.authentik_subject),                       -- guard above proves ≤1 distinct
    lower(u.email),
    (array_agg(u.name ORDER BY u.updated_at DESC))[1],
    max(u.mfa_enrolled_at),
    (array_agg(u.tenant_id ORDER BY u.updated_at DESC))[1],
    min(u.created_at),
    CURRENT_TIMESTAMP
FROM "users" u
GROUP BY lower(u.email);

-- ── users become memberships ────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "identity_id" TEXT;
ALTER TABLE "users" ADD COLUMN "last_active_at" TIMESTAMP(3);

UPDATE "users" u SET "identity_id" = i.id
FROM "identities" i WHERE lower(u.email) = i.email;

ALTER TABLE "users" ALTER COLUMN "identity_id" SET NOT NULL;

ALTER TABLE "users" ADD CONSTRAINT "users_identity_id_fkey"
    FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "users_tenant_id_identity_id_key" ON "users"("tenant_id", "identity_id");
CREATE INDEX "users_identity_id_idx" ON "users"("identity_id");

-- ── Drop the single-tenant linkage ─────────────────────────────────────────
DROP INDEX "users_authentik_subject_key";
ALTER TABLE "users" DROP COLUMN "authentik_subject";
ALTER TABLE "users" DROP COLUMN "mfa_enrolled_at";
