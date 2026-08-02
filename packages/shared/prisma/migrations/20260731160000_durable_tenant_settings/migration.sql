-- Durable storage for admin-configured tenant settings.
--
-- Business hours, the auto-greeting template and SLA targets lived only in
-- Redis, under keys with no TTL - a cache holding the sole copy of settings a
-- customer deliberately configured. Production Redis is persistent (a volume
-- added for BullMQ covered these by accident); the dev compose file had no
-- volume, so every teardown erased them there. Either way a FLUSHALL or an
-- eviction takes them, and the loss is silent: a missing business-hours config
-- reads as "open" by design, so the tenant simply becomes 24/7.
--
-- Postgres becomes the source of truth. Redis stays in front as the cache the
-- hot paths already read, under the SAME keys, so existing readers keep working
-- while they migrate one at a time.
--
-- Additive only: no column or table is dropped, and the Redis keys are left in
-- place. Backfill of existing values is a separate, re-runnable script
-- (scripts/backfill-durable-settings.ts) because it needs Redis, which SQL
-- cannot reach.

CREATE TABLE IF NOT EXISTS tenant_settings (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_settings_tenant_id_fkey'
  ) THEN
    ALTER TABLE tenant_settings
      ADD CONSTRAINT tenant_settings_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One value per (tenant, key). The upsert in writeDurableSetting depends on it.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_settings_tenant_id_key_key
  ON tenant_settings (tenant_id, key);

CREATE INDEX IF NOT EXISTS tenant_settings_tenant_id_idx
  ON tenant_settings (tenant_id);

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM tenant_settings;
  RAISE NOTICE 'tenant_settings ready (% rows). Run scripts/backfill-durable-settings.ts to import existing Redis values.', n;
END $$;
