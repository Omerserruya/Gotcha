-- Conversation relevance (2026-11-17). Additive only: nullable columns, no backfill, one index.
ALTER TABLE "conversations" ADD COLUMN "relevance_category" TEXT,
ADD COLUMN "relevance_confidence" REAL,
ADD COLUMN "relevance_reason" TEXT,
ADD COLUMN "relevance_source" TEXT,
ADD COLUMN "relevance_classified_at" TIMESTAMP(3),
ADD COLUMN "relevance_overridden_by" TEXT,
ADD COLUMN "relevance_overridden_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "conversations_tenant_id_relevance_category_idx" ON "conversations"("tenant_id", "relevance_category");
