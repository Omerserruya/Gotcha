-- Migration: notification_system
-- Adds the event-driven notification engine: NotificationPreference rules,
-- InAppNotification rows, and a per-user `notification_sound_enabled` flag.
-- Postgres-14 safe (no NULLS DISTINCT clause; uses partial indexes for the
-- (tenant_id, department_id, event_type) uniqueness with NULL departmentId).

-- 1. User flag for the per-user "play sound on new notification" preference.
ALTER TABLE "users"
  ADD COLUMN "notification_sound_enabled" BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. NotificationPreference table.
CREATE TABLE "notification_preferences" (
  "id"            TEXT NOT NULL,
  "tenant_id"     TEXT NOT NULL,
  "department_id" TEXT,
  "event_type"    TEXT NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT TRUE,
  "conditions"    JSONB,
  "recipients"    JSONB NOT NULL,
  "channels"      JSONB NOT NULL DEFAULT '["email","in_app"]'::JSONB,
  "priority"      TEXT NOT NULL DEFAULT 'MEDIUM',
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL;

CREATE INDEX "notification_preferences_tenant_id_event_type_idx"
  ON "notification_preferences" ("tenant_id", "event_type");

-- Partial unique index for the NULL department_id (tenant-default) case -
-- one row per (tenant_id, event_type). Mirrors the funnel_per_department
-- migration, since Postgres 14 lacks NULLS NOT DISTINCT.
CREATE UNIQUE INDEX "notification_preferences_tenant_id_null_dept_event_type_key"
  ON "notification_preferences" ("tenant_id", "event_type")
  WHERE "department_id" IS NULL;

-- Regular partial unique index for the explicit department case -
-- one row per (tenant_id, department_id, event_type).
CREATE UNIQUE INDEX "notification_preferences_tenant_id_department_id_event_type_key"
  ON "notification_preferences" ("tenant_id", "department_id", "event_type")
  WHERE "department_id" IS NOT NULL;

-- 3. InAppNotification table.
CREATE TABLE "in_app_notifications" (
  "id"         TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "priority"   TEXT NOT NULL DEFAULT 'MEDIUM',
  "title"      TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  "link"       TEXT,
  "read"       BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "in_app_notifications"
  ADD CONSTRAINT "in_app_notifications_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "in_app_notifications"
  ADD CONSTRAINT "in_app_notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE INDEX "in_app_notifications_user_id_read_created_at_idx"
  ON "in_app_notifications" ("user_id", "read", "created_at");

CREATE INDEX "in_app_notifications_tenant_id_created_at_idx"
  ON "in_app_notifications" ("tenant_id", "created_at");
