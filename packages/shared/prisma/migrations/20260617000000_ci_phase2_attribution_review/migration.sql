-- Customer Intelligence V2 - Phase 2: source attribution, examples-driven
-- extraction, per-field confidence thresholds, a migration-safe REVIEW_REQUIRED
-- scope, and a human-review queue for uncertain updates.
--
-- ADDITIVE, non-destructive, idempotent (IF NOT EXISTS / guarded enum ops) so it
-- is safe over a dev DB that may have been hot-patched via `db push`.

-- 1) REVIEW_REQUIRED scope - a field whose true scope is unknown (e.g. backfilled
--    from legacy summaryFields). The ingest layer NEVER routes it until a human
--    assigns a real scope. (ADD VALUE IF NOT EXISTS is supported on PG 12+.)
ALTER TYPE "IntelligenceScope" ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';

-- 2) Review-queue status enum (guarded create for idempotency).
DO $$ BEGIN
  CREATE TYPE "IntelligenceReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3) FieldDefinition: few-shot examples, negative examples, confidence threshold.
ALTER TABLE "field_definitions" ADD COLUMN IF NOT EXISTS "examples" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "field_definitions" ADD COLUMN IF NOT EXISTS "negative_examples" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "field_definitions" ADD COLUMN IF NOT EXISTS "confidence_threshold" DOUBLE PRECISION;

-- 4) IntelligenceFact: verbatim evidence snippet (provenance the UI shows).
ALTER TABLE "intelligence_facts" ADD COLUMN IF NOT EXISTS "evidence" TEXT;

-- 5) Human-review queue for uncertain / conflicting intelligence updates.
CREATE TABLE IF NOT EXISTS "intelligence_reviews" (
  "id"              TEXT NOT NULL,
  "tenant_id"       TEXT NOT NULL,
  "entity_type"     "IntelligenceScope" NOT NULL,
  "entity_id"       TEXT NOT NULL,
  "field_key"       TEXT NOT NULL,
  "proposed_value"  JSONB NOT NULL,
  "current_value"   JSONB,
  "confidence"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "evidence"        TEXT,
  "reason"          TEXT NOT NULL,
  "status"          "IntelligenceReviewStatus" NOT NULL DEFAULT 'PENDING',
  "source"          "FactSource" NOT NULL,
  "conversation_id" TEXT,
  "resolved_at"     TIMESTAMP(3),
  "resolved_by"     TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intelligence_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "intelligence_reviews_tenant_id_status_idx"
  ON "intelligence_reviews" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "intelligence_reviews_tenant_id_entity_type_entity_id_idx"
  ON "intelligence_reviews" ("tenant_id", "entity_type", "entity_id");
