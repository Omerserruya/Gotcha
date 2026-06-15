-- Migration: notification_pref_allow_multiple
-- Drop the two partial unique indexes that limited NotificationPreference to
-- one row per (tenant_id, department_id, event_type). The dispatcher already
-- iterates over every matching preference, so allowing multiple rows is the
-- single change needed to enable per-recipient channel routing - e.g. one
-- rule sends User A both email + in-app, a second rule sends User B in-app
-- only. Engine-level dedup ensures the same (user, channel) tuple isn't
-- delivered twice when two rules overlap.

DROP INDEX IF EXISTS "notification_preferences_tenant_id_null_dept_event_type_key";
DROP INDEX IF EXISTS "notification_preferences_tenant_id_department_id_event_type_key";
