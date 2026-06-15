-- AlterTable: add AI-specific denormalized columns for per-model cost + per-feature aggregation
ALTER TABLE "usage_logs"
  ADD COLUMN "feature"            TEXT,
  ADD COLUMN "model"              TEXT,
  ADD COLUMN "prompt_tokens"      INTEGER,
  ADD COLUMN "completion_tokens"  INTEGER,
  ADD COLUMN "cost_usd"           DECIMAL(12,6);

-- Backfill attempt from the pre-existing metadata JSON so historical rows
-- still show up in the admin aggregations. Nulls on fields that aren't in
-- metadata are fine - the aggregate queries tolerate them.
UPDATE "usage_logs"
SET
  "feature"           = COALESCE("metadata"->>'type', NULL),
  "model"             = COALESCE("metadata"->>'model', NULL),
  "prompt_tokens"     = NULLIF(("metadata"->>'input_tokens')::INTEGER, 0),
  "completion_tokens" = NULLIF(("metadata"->>'output_tokens')::INTEGER, 0)
WHERE "type" = 'ai_tokens';

-- Indexes to make the Platform Usage admin view fast
CREATE INDEX "usage_logs_tenant_id_feature_idx" ON "usage_logs"("tenant_id", "feature");
CREATE INDEX "usage_logs_tenant_id_model_idx"   ON "usage_logs"("tenant_id", "model");
