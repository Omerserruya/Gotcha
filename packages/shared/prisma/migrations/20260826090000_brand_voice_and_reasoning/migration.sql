-- The history rework produces three things the schema had nowhere to put:
-- the reasoning behind an answer, a stable category, and the brand's own voice.

ALTER TABLE "knowledge_candidates"
  ADD COLUMN IF NOT EXISTS "reasoning" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "scope" TEXT;

ALTER TABLE "historical_imports"
  ADD COLUMN IF NOT EXISTS "brand_voice" JSONB;

ALTER TABLE "business_profiles"
  ADD COLUMN IF NOT EXISTS "observed_voice" TEXT,
  ADD COLUMN IF NOT EXISTS "observed_voice_edited_at" TIMESTAMP(3);
