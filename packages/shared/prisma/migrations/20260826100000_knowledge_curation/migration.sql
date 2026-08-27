-- A final curation pass reads the whole candidate set and decides what is
-- durable knowledge, what needs restating, and what depends on live data.
ALTER TABLE "knowledge_candidates"
  ADD COLUMN IF NOT EXISTS "requires_live_lookup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "curation_verdict" TEXT,
  ADD COLUMN IF NOT EXISTS "curation_note" TEXT;
