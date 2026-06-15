-- Webhook trigger declared body schema.
--
-- Adds `body_schema` to webhook_triggers: the user-declared shape of the inbound
-- request body, stored as a JSON array of { key, type } objects (type is
-- "string" | "number" | "boolean"). This gives the mapper a known set of source
-- fields to bind from instead of free-text.
--
-- Declaration ONLY - inbound payloads are NOT validated/rejected against this
-- schema; the {{body.*}} reference behavior is unchanged.
--
-- Purely additive (new column with a default); existing rows get an empty array.
-- Idempotent so it is safe to re-run on environments seeded via `prisma db push`.

ALTER TABLE "webhook_triggers"
  ADD COLUMN IF NOT EXISTS "body_schema" JSONB NOT NULL DEFAULT '[]';
