-- Feature Permissions: two-layer (tenant + user) feature access control.
-- Schema mirrors packages/shared/src/lib/features.ts (FEATURES const).

-- ─── tenant_features ──────────────────────────────────────────
-- SYSTEM_ADMIN-controlled gate: which features a tenant is allowed to use.
CREATE TABLE "tenant_features" (
    "id"         TEXT          NOT NULL,
    "tenant_id"  TEXT          NOT NULL,
    "feature"    TEXT          NOT NULL,
    "enabled"    BOOLEAN       NOT NULL DEFAULT false,
    "config"     JSONB,
    "created_at" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3)  NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_features_tenant_id_feature_key"
  ON "tenant_features"("tenant_id", "feature");
CREATE INDEX "tenant_features_tenant_id_idx" ON "tenant_features"("tenant_id");

ALTER TABLE "tenant_features"
  ADD CONSTRAINT "tenant_features_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── tenant_roles ─────────────────────────────────────────────
-- Tenant-admin-managed custom roles (e.g. "Sales Manager", "Support Tier 2").
CREATE TABLE "tenant_roles" (
    "id"          TEXT         NOT NULL,
    "tenant_id"   TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    "description" TEXT,
    "is_system"   BOOLEAN      NOT NULL DEFAULT false,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_roles_tenant_id_name_key"
  ON "tenant_roles"("tenant_id", "name");
CREATE INDEX "tenant_roles_tenant_id_idx" ON "tenant_roles"("tenant_id");

ALTER TABLE "tenant_roles"
  ADD CONSTRAINT "tenant_roles_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── tenant_role_features ────────────────────────────────────
-- Features granted to a role.
CREATE TABLE "tenant_role_features" (
    "role_id"    TEXT         NOT NULL,
    "feature"    TEXT         NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_role_features_pkey" PRIMARY KEY ("role_id", "feature")
);

CREATE INDEX "tenant_role_features_feature_idx" ON "tenant_role_features"("feature");

ALTER TABLE "tenant_role_features"
  ADD CONSTRAINT "tenant_role_features_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "tenant_roles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── user_role_assignments ───────────────────────────────────
-- Many-to-many: users ↔ custom tenant roles.
CREATE TABLE "user_role_assignments" (
    "user_id"     TEXT         NOT NULL,
    "role_id"     TEXT         NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT,

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("user_id", "role_id")
);

CREATE INDEX "user_role_assignments_role_id_idx" ON "user_role_assignments"("role_id");

ALTER TABLE "user_role_assignments"
  ADD CONSTRAINT "user_role_assignments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_role_assignments"
  ADD CONSTRAINT "user_role_assignments_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "tenant_roles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── user_feature_grants ─────────────────────────────────────
-- Per-user grant (true) or revoke (false) overriding role-derived access.
CREATE TABLE "user_feature_grants" (
    "id"         TEXT         NOT NULL,
    "user_id"    TEXT         NOT NULL,
    "feature"    TEXT         NOT NULL,
    "granted"    BOOLEAN      NOT NULL,
    "reason"     TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "user_feature_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_feature_grants_user_id_feature_key"
  ON "user_feature_grants"("user_id", "feature");
CREATE INDEX "user_feature_grants_user_id_idx" ON "user_feature_grants"("user_id");

ALTER TABLE "user_feature_grants"
  ADD CONSTRAINT "user_feature_grants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Backfill: existing tenant Boolean flags → tenant_features rows ──
-- Old Boolean columns (bot_enabled, voice_copilot_enabled, etc.) are kept
-- for now; a follow-up migration will drop them once all call sites read
-- through hasFeature(). Until then, the resolver falls back to the column
-- when no tenant_features row exists, so old code keeps working.
INSERT INTO "tenant_features" ("id", "tenant_id", "feature", "enabled", "updated_at")
SELECT
  'tf_' || gen_random_uuid()::text,
  "id",
  'bot',
  COALESCE("bot_enabled", false),
  CURRENT_TIMESTAMP
FROM "tenants"
ON CONFLICT ("tenant_id", "feature") DO NOTHING;

INSERT INTO "tenant_features" ("id", "tenant_id", "feature", "enabled", "updated_at")
SELECT
  'tf_' || gen_random_uuid()::text,
  "id",
  'first_take_care',
  COALESCE("first_take_care_enabled", false),
  CURRENT_TIMESTAMP
FROM "tenants"
ON CONFLICT ("tenant_id", "feature") DO NOTHING;

INSERT INTO "tenant_features" ("id", "tenant_id", "feature", "enabled", "updated_at")
SELECT
  'tf_' || gen_random_uuid()::text,
  "id",
  'voice_copilot',
  COALESCE("voice_copilot_enabled", false),
  CURRENT_TIMESTAMP
FROM "tenants"
ON CONFLICT ("tenant_id", "feature") DO NOTHING;

INSERT INTO "tenant_features" ("id", "tenant_id", "feature", "enabled", "updated_at")
SELECT
  'tf_' || gen_random_uuid()::text,
  "id",
  'voice_inbox_ui',
  COALESCE("voice_inbox_ui_enabled", false),
  CURRENT_TIMESTAMP
FROM "tenants"
ON CONFLICT ("tenant_id", "feature") DO NOTHING;

INSERT INTO "tenant_features" ("id", "tenant_id", "feature", "enabled", "updated_at")
SELECT
  'tf_' || gen_random_uuid()::text,
  "id",
  'voice_incoming',
  COALESCE("voice_incoming_enabled", false),
  CURRENT_TIMESTAMP
FROM "tenants"
ON CONFLICT ("tenant_id", "feature") DO NOTHING;
